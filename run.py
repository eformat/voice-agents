"""Run the graph."""

import argparse

from langchain_core.messages import HumanMessage
from langgraph.graph import START, StateGraph

from src.nodes import (
    SupervisorState,
    supervisor_command_node,
    text_to_speech_agent_node,
)


def build_graph() -> StateGraph:
    """Build graph using Command for dynamic routing.

    Architecture:
    - Flat graph with two agent nodes
    - Command handles all routing dynamically (no explicit edges needed beyond START)
    """
    graph = StateGraph(SupervisorState)

    # Add agent nodes
    graph.add_node("supervisor", supervisor_command_node)
    graph.add_node("text_to_speech_agent", text_to_speech_agent_node)

    # Set entry point (Command handles all other routing)
    graph.add_edge(START, "supervisor")
    graph.add_edge("supervisor", "text_to_speech_agent")
    graph.add_edge("text_to_speech_agent", "__end__")

    return graph.compile()


if __name__ == "__main__":
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Command-based routing example")
    parser.add_argument("query", nargs="?", default="Can i order a pizza?")
    args = parser.parse_args()

    print("EXAMPLE: Voice Agents")
    print("=" * 70)
    print(f"Query: {args.query}\n")

    # Build and invoke graph
    graph = build_graph()
    graph.get_graph().print_ascii()
    final_state = graph.invoke({"messages": [HumanMessage(content=args.query)]})

    print("\n" + "=" * 70)
    print("STATE UPDATE:")
    print("=" * 70)
