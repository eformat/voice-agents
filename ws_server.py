#!/usr/bin/env python3
"""WebSocket server for browser audio -> STT -> agent graph.

Protocol (client -> server):
  - JSON text message:
      {"type":"audio_wav_b64","audio_b64":"...base64..."}
      {"type":"text","text":"..."}
      {"type":"tts_text","text":"..."}  # test streaming TTS only (no graph)

Protocol (server -> client):
  - JSON text message:
      {"type":"transcript","text":"..."}
      {"type":"graph_result","pizza_type":"...","messages":[{"role":"...","content":"..."}]}
      {"type":"tts_begin","format":"pcm_s16le","sample_rate":24000}
      # After tts_begin, server streams raw binary websocket frames containing pcm_s16le bytes.
      {"type":"tts_end"}
      # (fallback)
      {"type":"tts_audio","format":"wav","sample_rate":24000,"audio_b64":"..."}
      {"type":"error","error":"..."}
"""

import asyncio
import base64
import json
import os
import re
import signal
import threading
import uuid
from typing import Any

import websockets
from langchain_core.globals import set_debug
from langchain_core.messages import HumanMessage
from langgraph.types import Command
from websockets.exceptions import ConnectionClosed

from src.content_utils import normalize_content_to_text
from src.graph import build_graph
from src.tools import (
    TTS_SAMPLE_RATE,
    convert_speech_to_text,
    generate_tts_wav_b64,
    stream_tts_pcm_chunks,
)

set_debug(True)


def _safe_messages(result: dict) -> list[dict[str, str]]:
    msgs = []
    for m in result.get("messages", []):
        content = normalize_content_to_text(getattr(m, "content", str(m)))
        msgs.append(
            {
                "role": getattr(m, "name", None) or getattr(m, "type", "message"),
                "content": content,
            }
        )
    return msgs


GRAPH = build_graph()


def _interrupt_values(result: dict) -> list[Any]:
    values: list[Any] = []
    for item in result.get("__interrupt__", []) or []:
        values.append(getattr(item, "value", item))
    return values


_TTS_CALL_RE = re.compile(r'convert_text_to_speech\\(.*?text\\s*=\\s*"(.*?)".*?\\)')


def _select_tts_text(result: dict) -> str:
    """Pick a reasonable text snippet from the graph result to speak."""
    ints = _interrupt_values(result)
    if ints and isinstance(ints[0], dict):
        prompt = normalize_content_to_text(ints[0].get("prompt") or "")
        m = _TTS_CALL_RE.search(prompt)
        if m:
            return m.group(1).strip()
        return prompt

    for m in reversed(result.get("messages", []) or []):
        role = getattr(m, "name", None) or getattr(m, "type", "")
        content = normalize_content_to_text(getattr(m, "content", "") or "")
        if not content:
            continue
        if content.startswith("Routing to"):
            continue
        if role == "human":
            continue
        mm = _TTS_CALL_RE.search(content)
        if mm:
            return mm.group(1).strip()
        return content
    return ""


async def _invoke_graph(inputs: Any, config: dict) -> dict:
    """Invoke graph in a thread to avoid blocking the WS event loop."""
    return await asyncio.to_thread(GRAPH.invoke, inputs, config)


async def _tts_payload(text: str) -> dict:
    """Generate TTS payload without blocking the WS event loop."""
    return await asyncio.to_thread(generate_tts_wav_b64, text)


async def _tts_stream(ws, text: str) -> None:
    """Stream TTS PCM audio chunks to the client over WS."""
    if not text or not text.strip():
        return
    loop = asyncio.get_running_loop()
    q: asyncio.Queue[bytes | None] = asyncio.Queue()

    # Even if the upstream TTS stream yields large bursts, we re-chunk to small WS frames
    # to reduce browser-side jitter/underruns.
    ws_chunk_ms = int(os.getenv("WS_TTS_CHUNK_MS", "40"))
    ws_chunk_samples = max(1, int(TTS_SAMPLE_RATE * (ws_chunk_ms / 1000.0)))
    ws_chunk_bytes = ws_chunk_samples * 2  # int16 mono
    # Ensure even number of bytes (whole int16 frames).
    if ws_chunk_bytes % 2 != 0:
        ws_chunk_bytes += 1

    def _producer() -> None:
        try:
            for chunk in stream_tts_pcm_chunks(text):
                loop.call_soon_threadsafe(q.put_nowait, chunk)
        except Exception as exc:
            # Surface error as special marker; consumer will emit error.
            loop.call_soon_threadsafe(
                q.put_nowait, b"__ERROR__" + str(exc).encode("utf-8")
            )
        finally:
            loop.call_soon_threadsafe(q.put_nowait, None)

    threading.Thread(target=_producer, daemon=True).start()

    await ws.send(
        json.dumps(
            {"type": "tts_begin", "format": "pcm_s16le", "sample_rate": TTS_SAMPLE_RATE}
        )
    )
    sent_first_token = False
    while True:
        item = await q.get()
        if item is None:
            break
        if item.startswith(b"__ERROR__"):
            err = item[len(b"__ERROR__") :].decode("utf-8", errors="replace")
            await ws.send(
                json.dumps({"type": "error", "error": f"TTS stream failed: {err}"})
            )
            await ws.send(json.dumps({"type": "tts_end"}))
            return
        if not sent_first_token:
            # "True" TTFT marker for the TTS stream: first streamed chunk from the model.
            await ws.send(json.dumps({"type": "tts_first_token"}))
            sent_first_token = True
        # Send raw PCM bytes as binary WS messages, re-chunked to small frames.
        for i in range(0, len(item), ws_chunk_bytes):
            await ws.send(item[i : i + ws_chunk_bytes])
    await ws.send(json.dumps({"type": "tts_end"}))


async def handler(ws):
    """Web Socket handler. Per-client conversation state (fresh for each WS connection)."""
    thread_id = f"ws-{uuid.uuid4()}"
    config = {"configurable": {"thread_id": thread_id}}
    awaiting_resume = False
    async for raw in ws:
        print(f"[ws] recv: {raw[:200]}", flush=True)
        try:
            data = json.loads(raw)
        except Exception:
            await ws.send(
                json.dumps({"type": "error", "error": "Invalid JSON message"})
            )
            continue

        msg_type = data.get("type")
        try:
            if msg_type == "audio_wav_b64":
                audio_b64 = data.get("audio_b64", "")
                audio_bytes = base64.b64decode(audio_b64)
                transcript = convert_speech_to_text.func(audio_bytes)
                print(f"[ws] transcript: {transcript!r}", flush=True)
                await ws.send(json.dumps({"type": "transcript", "text": transcript}))
                try:
                    inputs = (
                        Command(resume=transcript)
                        if awaiting_resume
                        else {"messages": [HumanMessage(content=transcript)]}
                    )
                    result = await asyncio.wait_for(
                        _invoke_graph(inputs, config), timeout=45
                    )
                except asyncio.TimeoutError:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "Graph invoke timed out (45s). Check MODEL_NAME/BASE_URL/API_KEY connectivity.",
                            }
                        )
                    )
                    continue
                interrupt_values = _interrupt_values(result)
                awaiting_resume = bool(interrupt_values)
                await ws.send(
                    json.dumps(
                        {
                            "type": "graph_result",
                            "pizza_type": result.get("pizza_type", ""),
                            "messages": _safe_messages(result),
                            "interrupt": interrupt_values[0]
                            if interrupt_values
                            else None,
                        }
                    )
                )
                speak_text = _select_tts_text(result)
                try:
                    await _tts_stream(ws, speak_text)
                except Exception as exc:
                    # Fallback: single WAV blob
                    try:
                        tts = await _tts_payload(speak_text)
                        if tts.get("audio_b64"):
                            await ws.send(json.dumps({"type": "tts_audio", **tts}))
                    except Exception:
                        await ws.send(
                            json.dumps({"type": "error", "error": f"TTS failed: {exc}"})
                        )
            elif msg_type == "text":
                text = data.get("text", "")
                print(f"[ws] text: {text!r}", flush=True)
                try:
                    inputs = (
                        Command(resume=text)
                        if awaiting_resume
                        else {"messages": [HumanMessage(content=text)]}
                    )
                    result = await asyncio.wait_for(
                        _invoke_graph(inputs, config), timeout=45
                    )
                except asyncio.TimeoutError:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "error",
                                "error": "Graph invoke timed out (45s). Check MODEL_NAME/BASE_URL/API_KEY connectivity.",
                            }
                        )
                    )
                    continue
                interrupt_values = _interrupt_values(result)
                awaiting_resume = bool(interrupt_values)
                await ws.send(
                    json.dumps(
                        {
                            "type": "graph_result",
                            "pizza_type": result.get("pizza_type", ""),
                            "messages": _safe_messages(result),
                            "interrupt": interrupt_values[0]
                            if interrupt_values
                            else None,
                        }
                    )
                )
                speak_text = _select_tts_text(result)
                try:
                    await _tts_stream(ws, speak_text)
                except Exception as exc:
                    # Fallback: single WAV blob
                    try:
                        tts = await _tts_payload(speak_text)
                        if tts.get("audio_b64"):
                            await ws.send(json.dumps({"type": "tts_audio", **tts}))
                    except Exception:
                        await ws.send(
                            json.dumps({"type": "error", "error": f"TTS failed: {exc}"})
                        )
            elif msg_type == "tts_text":
                # Debug / testing endpoint: stream TTS audio directly without invoking the graph.
                speak_text = (data.get("text") or "").strip()
                if not speak_text:
                    await ws.send(
                        json.dumps({"type": "error", "error": "No text provided"})
                    )
                    continue
                try:
                    await _tts_stream(ws, speak_text)
                except Exception as exc:
                    await ws.send(
                        json.dumps(
                            {"type": "error", "error": f"TTS stream failed: {exc}"}
                        )
                    )
            else:
                await ws.send(
                    json.dumps({"type": "error", "error": f"Unknown type: {msg_type}"})
                )
        except ConnectionClosed:
            # Client disconnected; nothing more to do for this connection.
            break
        except Exception as exc:
            print(f"[ws] error: {exc}", flush=True)
            try:
                await ws.send(json.dumps({"type": "error", "error": str(exc)}))
            except ConnectionClosed:
                break


async def main(host: str = "0.0.0.0", port: int = 8765):
    """Main function to start the WS server."""
    if websockets is None:
        raise RuntimeError(
            "Missing dependency: websockets. Install with `pip install websockets`."
        )
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _request_shutdown(signame: str) -> None:
        print(f"Received {signame}. Forcing shutdown...", flush=True)
        # Cancel all tasks so asyncio.run can unwind quickly.
        for task in asyncio.all_tasks(loop):
            task.cancel()
        if not stop_event.is_set():
            stop_event.set()
        # Hard-exit after a short delay in case worker threads block exit.
        loop.call_later(0.5, lambda: os._exit(0))

    try:
        loop.add_signal_handler(signal.SIGINT, _request_shutdown, "SIGINT")
        loop.add_signal_handler(signal.SIGTERM, _request_shutdown, "SIGTERM")
    except NotImplementedError:
        signal.signal(signal.SIGINT, lambda *_: _request_shutdown("SIGINT"))
        signal.signal(signal.SIGTERM, lambda *_: _request_shutdown("SIGTERM"))

    async with websockets.serve(handler, host, port, max_size=20 * 1024 * 1024):
        print(f"WS server listening on ws://{host}:{port}", flush=True)
        await stop_event.wait()


if __name__ == "__main__":
    asyncio.run(main())
