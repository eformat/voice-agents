"""Graph construction shared between CLI and web server."""

from langgraph.graph import START, StateGraph

from src.nodes import (
    SupervisorState,
    delivery_agent_node,
    order_agent_node,
    pizza_agent_node,
    supervisor_command_node,
)


def build_graph():
    """Compile and return the LangGraph instance."""
    graph = StateGraph(SupervisorState)
    graph.add_node("supervisor", supervisor_command_node)
    graph.add_node("order_agent", order_agent_node)
    graph.add_node("pizza_agent", pizza_agent_node)
    graph.add_node("delivery_agent", delivery_agent_node)
    # Set entry point (Command handles all other routing)
    graph.add_edge(START, "supervisor")
    return graph.compile()
