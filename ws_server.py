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
      {"type":"error","error":"..."}
"""

import asyncio
import base64
import json
from typing import Any

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None
from langchain_core.globals import set_debug
from langchain_core.messages import HumanMessage

from src.graph import build_graph
from src.tools import convert_speech_to_text

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


async def _invoke_graph(state: dict) -> dict:
    """Invoke graph in a thread to avoid blocking the WS event loop."""
    return await asyncio.to_thread(GRAPH.invoke, state)


async def handler(ws):
    """Web Socket handler. Per-client conversation state (fresh for each WS connection)."""
    state: dict[str, Any] = {"messages": []}
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
                # Append human message into state and invoke graph with full history.
                state["messages"] = list(state.get("messages", [])) + [
                    HumanMessage(content=transcript)
                ]
                try:
                    result = await asyncio.wait_for(_invoke_graph(state), timeout=45)
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
                # Persist returned state for next turn.
                state = result
                await ws.send(
                    json.dumps(
                        {
                            "type": "graph_result",
                            "pizza_type": result.get("pizza_type", ""),
                            "messages": _safe_messages(result),
                        }
                    )
                )
            elif msg_type == "text":
                text = data.get("text", "")
                print(f"[ws] text: {text!r}", flush=True)
                try:
                    state["messages"] = list(state.get("messages", [])) + [
                        HumanMessage(content=text)
                    ]
                    result = await asyncio.wait_for(_invoke_graph(state), timeout=45)
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
                state = result
                await ws.send(
                    json.dumps(
                        {
                            "type": "graph_result",
                            "pizza_type": result.get("pizza_type", ""),
                            "messages": _safe_messages(result),
                        }
                    )
                )
            else:
                await ws.send(
                    json.dumps({"type": "error", "error": f"Unknown type: {msg_type}"})
                )
        except Exception as exc:
            print(f"[ws] error: {exc}", flush=True)
            await ws.send(json.dumps({"type": "error", "error": str(exc)}))


async def main(host: str = "127.0.0.1", port: int = 8765):
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
