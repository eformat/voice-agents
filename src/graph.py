"""Graph construction shared between CLI and web server."""

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, StateGraph

from src.nodes import (
    SupervisorState,
    delivery_agent_node,
    order_agent_node,
    pizza_agent_node,
    supervisor_command_node,
    wait_for_user_after_delivery,
    wait_for_user_after_order,
    wait_for_user_after_pizza,
)


def build_graph():
    """Compile and return the LangGraph instance (with checkpointer for interrupts)."""
    graph = StateGraph(SupervisorState)
    graph.add_node("supervisor", supervisor_command_node)
    graph.add_node("order_agent", order_agent_node)
    graph.add_node("pizza_agent", pizza_agent_node)
    graph.add_node("delivery_agent", delivery_agent_node)

    # Interrupt nodes
    graph.add_node("wait_for_user_after_pizza", wait_for_user_after_pizza)
    graph.add_node("wait_for_user_after_order", wait_for_user_after_order)
    graph.add_node("wait_for_user_after_delivery", wait_for_user_after_delivery)

    graph.add_edge(START, "supervisor")
    return graph.compile(checkpointer=MemorySaver())
