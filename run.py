"""Voice agents example."""

import argparse
import asyncio
import contextlib

import speech_recognition as sr
from langchain_core.messages import HumanMessage
from langgraph.graph import START, StateGraph

from src.nodes import (
    SupervisorState,
    delivery_agent_node,
    order_agent_node,
    pizza_agent_node,
    supervisor_command_node,
)
from src.tools import (
    convert_speech_to_text,
    is_listening_paused,
)


def build_graph() -> StateGraph:
    """Build graph using Command for dynamic routing."""
    graph = StateGraph(SupervisorState)

    # Add agent nodes
    graph.add_node("supervisor", supervisor_command_node)
    graph.add_node("order_agent", order_agent_node)
    graph.add_node("pizza_agent", pizza_agent_node)
    graph.add_node("delivery_agent", delivery_agent_node)

    # Set entry point (Command handles all other routing)
    graph.add_edge(START, "supervisor")

    return graph.compile()


def start_background_listener(queue: asyncio.Queue) -> callable:
    """Start background speech recognition; enqueue transcripts."""
    recognizer = sr.Recognizer()
    mic = sr.Microphone()

    with mic as source:
        print("Adjusting for ambient noise, please wait...")
        recognizer.adjust_for_ambient_noise(source)
        print("Adjustment complete. Starting background listening.")

    def callback(recognizer: sr.Recognizer, audio: sr.AudioData) -> None:
        if is_listening_paused():
            return
        try:
            wav_bytes = audio.get_wav_data()
            text = convert_speech_to_text.func(wav_bytes)
            print(f"Recognized (background via STT tool): {text}")
            queue.put_nowait(text)
        except Exception as exc:
            print(f"Speech recognition service error: {exc}")

    stop_listening = recognizer.listen_in_background(mic, callback)
    return stop_listening


async def main() -> None:
    """Main function to start the background listener and consume transcripts."""
    parser = argparse.ArgumentParser(description="Command-based routing example")
    parser.add_argument("query", nargs="?", default="Can i order a pizza?")
    parser.parse_args()

    # Always build graph
    graph = build_graph()
    graph.get_graph().print_ascii()
    print("Starting background listening. Say Ctrl+C to stop.")

    queue: asyncio.Queue = asyncio.Queue()
    stop_listening = start_background_listener(queue)

    async def consumer() -> None:
        while True:
            transcript = await queue.get()
            print("Transcript:", transcript)
            if transcript:
                try:
                    result = graph.invoke(
                        {"messages": [HumanMessage(content=transcript)]}
                    )
                    print("Graph result:", result)

                    # Show extracted pizza type
                    print("\n" + "=" * 70)
                    print("STATE UPDATE:")
                    print(
                        f"  pizza_type: '{result.get('pizza_type', '(not extracted)')}'"
                    )
                    print("=" * 70)

                except Exception as exc:
                    print(f"Graph invocation failed: {exc}")
                queue.task_done()

    consumer_task = asyncio.create_task(consumer())

    try:
        while True:
            await asyncio.sleep(0.5)
    except KeyboardInterrupt:
        print("Stopping listener...")
    finally:
        stop_listening(wait_for_stop=False)
        consumer_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await consumer_task


if __name__ == "__main__":
    asyncio.run(main())
