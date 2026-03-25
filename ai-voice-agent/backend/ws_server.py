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
import logging
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

# Suppress noisy "opening handshake failed" from k8s tcpSocket probes
logging.getLogger("websockets").setLevel(logging.CRITICAL)

from src.content_utils import normalize_content_to_text
from src.graph import build_graph
from src.nodes import GUARDRAILS_URL, NEMO_GUARDRAILS_URL
from src.tools import (
    TTS_SAMPLE_RATE,
    convert_speech_to_text,
    generate_tts_wav_b64,
    stream_tts_pcm_chunks,
)

set_debug(True)

# ─── Optional MLflow tracing ────────────────────────────────────────────────
_mlflow_uri = os.environ.get("MLFLOW_TRACKING_URI", "").strip()
_mlflow_enabled = False
if _mlflow_uri:
    try:
        import mlflow
        from mlflow.langchain.langchain_tracer import MlflowLangchainTracer

        mlflow.set_tracking_uri(_mlflow_uri)
        experiment_name = os.environ.get("MLFLOW_EXPERIMENT_NAME", "ai-voice-agent")
        mlflow.set_experiment(experiment_name)
        _mlflow_enabled = True
        print(f"[mlflow] Tracing enabled → {_mlflow_uri}  experiment={experiment_name}", flush=True)
    except Exception as exc:
        print(f"[mlflow] Failed to initialise tracing (continuing without): {exc}", flush=True)


def _mlflow_callbacks() -> list:
    """Return MLflow callback handlers if tracing is enabled, else empty list."""
    if not _mlflow_enabled:
        return []
    try:
        return [MlflowLangchainTracer()]
    except Exception:
        return []


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


GRAPH = build_graph(mode="none")
GRAPH_FMS = build_graph(mode="fms") if GUARDRAILS_URL else None
GRAPH_NEMO = build_graph(mode="nemo") if NEMO_GUARDRAILS_URL else None
GRAPH_BOTH = build_graph(mode="both") if (GUARDRAILS_URL and NEMO_GUARDRAILS_URL) else None


def _interrupt_values(result: dict) -> list[Any]:
    values: list[Any] = []
    for item in result.get("__interrupt__", []) or []:
        values.append(getattr(item, "value", item))
    return values


_TTS_CALL_RE = re.compile(r'convert_text_to_speech\(.*?text\s*=\s*"(.*?)".*?\)')


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


_GRAPHS = {
    "none": GRAPH,
    "fms": GRAPH_FMS,
    "nemo": GRAPH_NEMO,
    "both": GRAPH_BOTH,
}


async def _invoke_graph(inputs: Any, config: dict, mode: str = "none") -> dict:
    """Invoke graph in a thread to avoid blocking the WS event loop."""
    callbacks = _mlflow_callbacks()
    if callbacks:
        config = {**config, "callbacks": callbacks}
    graph = _GRAPHS.get(mode) or GRAPH
    return await asyncio.to_thread(graph.invoke, inputs, config)


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
    def _producer() -> None:
        try:
            for chunk in stream_tts_pcm_chunks(text):
                if not chunk:
                    continue
                loop.call_soon_threadsafe(q.put_nowait, chunk)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, None)

    await ws.send(
        json.dumps({"type": "tts_begin", "format": "pcm_s16le", "sample_rate": TTS_SAMPLE_RATE})
    )
    # Run the producer in a thread WITHOUT awaiting it so the consumer loop
    # below can send chunks to the browser as they arrive (true streaming).
    loop.run_in_executor(None, _producer)

    buffered = bytearray()
    while True:
        chunk = await q.get()
        if chunk is None:
            break
        buffered.extend(chunk)
        # Send in 20ms frames (s16le, mono).
        frame_bytes = int(TTS_SAMPLE_RATE * 0.02) * 2
        while len(buffered) >= frame_bytes:
            frame = bytes(buffered[:frame_bytes])
            del buffered[:frame_bytes]
            await ws.send(frame)

    # Send remaining bytes (if any).
    if buffered:
        await ws.send(bytes(buffered))

    await ws.send(json.dumps({"type": "tts_end"}))


async def handler(ws) -> None:
    awaiting_resume = False
    guardrails_mode = "none"
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}
    # Tell the client which guardrails backends are available.
    await ws.send(json.dumps({
        "type": "guardrails_available",
        "available": bool(GUARDRAILS_URL),
        "fms_guardrails_available": bool(GUARDRAILS_URL),
        "nemo_guardrails_available": bool(NEMO_GUARDRAILS_URL),
    }))
    while True:
        try:
            raw = await ws.recv()
            if isinstance(raw, bytes):
                # Ignore binary frames from client (not supported).
                continue
            data = json.loads(raw)
            msg_type = data.get("type")
            if msg_type == "audio_wav_b64":
                b64 = data.get("audio_b64") or ""
                if not b64:
                    await ws.send(json.dumps({"type": "error", "error": "No audio provided"}))
                    continue
                audio = base64.b64decode(b64)
                text = convert_speech_to_text.invoke({"audio": audio})
                await ws.send(json.dumps({"type": "transcript", "text": text}))
                inputs = (
                    Command(resume=text)
                    if awaiting_resume
                    else {"messages": [HumanMessage(content=text)]}
                )
                result = await _invoke_graph(inputs, config, mode=guardrails_mode)
                interrupt_values = _interrupt_values(result)
                awaiting_resume = bool(interrupt_values)
                await ws.send(
                    json.dumps(
                        {
                            "type": "graph_result",
                            "pizza_type": result.get("pizza_type", ""),
                            "messages": _safe_messages(result),
                            "interrupt": interrupt_values[0] if interrupt_values else None,
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
                text = (data.get("text") or "").strip()
                if not text:
                    await ws.send(json.dumps({"type": "error", "error": "No text provided"}))
                    continue
                print(f"[ws] text: {text!r}", flush=True)
                try:
                    inputs = (
                        Command(resume=text)
                        if awaiting_resume
                        else {"messages": [HumanMessage(content=text)]}
                    )
                    result = await asyncio.wait_for(
                        _invoke_graph(inputs, config, mode=guardrails_mode), timeout=45
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
                    await ws.send(json.dumps({"type": "error", "error": "No text provided"}))
                    continue
                try:
                    await _tts_stream(ws, speak_text)
                except Exception as exc:
                    await ws.send(
                        json.dumps(
                            {"type": "error", "error": f"TTS stream failed: {exc}"}
                        )
                    )
            elif msg_type == "set_guardrails":
                guardrails_enabled = bool(data.get("enabled", False))
                guardrails_mode = "fms" if guardrails_enabled else "none"
                print(f"[ws] guardrails mode={guardrails_mode}", flush=True)
                await ws.send(json.dumps({"type": "guardrails_status", "enabled": guardrails_enabled}))
            elif msg_type == "set_guardrails_mode":
                requested_mode = data.get("mode", "none")
                if requested_mode in ("none", "fms", "nemo", "both"):
                    guardrails_mode = requested_mode
                else:
                    guardrails_mode = "none"
                print(f"[ws] guardrails mode={guardrails_mode}", flush=True)
                await ws.send(json.dumps({"type": "guardrails_mode", "mode": guardrails_mode}))
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
    # websockets is a required dependency - import would fail at module level if missing
    assert websockets is not None
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
