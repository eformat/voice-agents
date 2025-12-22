#!/usr/bin/env python3
"""WebSocket server for browser audio -> STT -> agent graph.

Protocol (client -> server):
  - JSON text message:
      {"type":"audio_wav_b64","audio_b64":"...base64..."}
      {"type":"text","text":"..."}

Protocol (server -> client):
  - JSON text message:
      {"type":"transcript","text":"..."}
      {"type":"graph_result","pizza_type":"...","messages":[{"role":"...","content":"..."}]}
      {"type":"tts_audio","format":"wav","sample_rate":24000,"audio_b64":"..."}
      {"type":"error","error":"..."}
"""

import asyncio
import base64
import json
import re
import uuid
from typing import Any

import websockets
from langchain_core.globals import set_debug
from langchain_core.messages import HumanMessage
from langgraph.types import Command

from src.graph import build_graph
from src.tools import convert_speech_to_text, generate_tts_wav_b64

set_debug(True)


def _safe_messages(result: dict) -> list[dict[str, str]]:
    msgs = []
    for m in result.get("messages", []):
        msgs.append(
            {
                "role": getattr(m, "name", None) or getattr(m, "type", "message"),
                "content": getattr(m, "content", str(m)),
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
        prompt = (ints[0].get("prompt") or "").strip()
        m = _TTS_CALL_RE.search(prompt)
        if m:
            return m.group(1).strip()
        return prompt

    for m in reversed(result.get("messages", []) or []):
        role = getattr(m, "name", None) or getattr(m, "type", "")
        content = (getattr(m, "content", "") or "").strip()
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
                try:
                    speak_text = _select_tts_text(result)
                    tts = await _tts_payload(speak_text)
                    if tts.get("audio_b64"):
                        print(
                            f"[ws] send tts_audio (len={len(tts['audio_b64'])})",
                            flush=True,
                        )
                        await ws.send(json.dumps({"type": "tts_audio", **tts}))
                except Exception as exc:
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
                try:
                    speak_text = _select_tts_text(result)
                    tts = await _tts_payload(speak_text)
                    if tts.get("audio_b64"):
                        print(
                            f"[ws] send tts_audio (len={len(tts['audio_b64'])})",
                            flush=True,
                        )
                        await ws.send(json.dumps({"type": "tts_audio", **tts}))
                except Exception as exc:
                    await ws.send(
                        json.dumps({"type": "error", "error": f"TTS failed: {exc}"})
                    )
            else:
                await ws.send(
                    json.dumps({"type": "error", "error": f"Unknown type: {msg_type}"})
                )
        except Exception as exc:
            print(f"[ws] error: {exc}", flush=True)
            await ws.send(json.dumps({"type": "error", "error": str(exc)}))


async def main(host: str = "0.0.0.0", port: int = 8765):
    """Main function to start the WS server."""
    if websockets is None:
        raise RuntimeError(
            "Missing dependency: websockets. Install with `pip install websockets`."
        )
    async with websockets.serve(handler, host, port, max_size=20 * 1024 * 1024):
        print(f"WS server listening on ws://{host}:{port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
