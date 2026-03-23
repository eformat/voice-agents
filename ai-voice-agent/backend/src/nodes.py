"""Node functions for supervisor and specialist agents."""

from __future__ import annotations

import json
import os
from typing import Annotated, Literal

from dotenv import load_dotenv
import httpx
from langgraph.prebuilt import create_react_agent
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph.message import add_messages
from langgraph.types import Command, interrupt
from pydantic import BaseModel
from typing_extensions import TypedDict

from src.content_utils import normalize_content_to_text
from src.prompts import (
    DELIVERY_AGENT_PROMPT,
    ORDER_AGENT_PROMPT,
    PIZZA_AGENT_PROMPT,
    SUPERVISOR_PROMPT,
)
from src.tools import (
    add_to_order,
    choose_delivery,
    get_pizza_type,
)

load_dotenv()

MODEL_NAME = os.getenv("MODEL_NAME", "MODEL_NAME")
BASE_URL = os.getenv("BASE_URL", "BASE_URL")
API_KEY = os.getenv("API_KEY", "API_KEY")
GUARDRAILS_URL = os.getenv("GUARDRAILS_URL", "")

# ============================================================
# Configuration
# ============================================================
TEMPERATURE = 0.2
MAX_RETRIES = 2
TIMEOUT = 30

_LLM_COMMON = dict(
    streaming=True,
    model=MODEL_NAME,
    temperature=TEMPERATURE,
    max_retries=MAX_RETRIES,
    timeout=TIMEOUT,
    api_key=API_KEY,
)
_EXTRA_BODY = {"chat_template_kwargs": {"enable_thinking": False}}

llm = ChatOpenAI(base_url=BASE_URL, extra_body=_EXTRA_BODY, **_LLM_COMMON)

# ============================================================
# Guardrails detector configurations
# ============================================================
GUARDRAILS_DETECTORS = {
    "input": {
        "gibberish-detector": {},
        "ibm-hate-and-profanity-detector": {},
        "prompt-injection-detector": {},
        "built-in-detector": {},
    },
    "output": {
        "gibberish-detector": {},
        "ibm-hate-and-profanity-detector": {},
        "built-in-detector": {},
    },
}

# Input-only screening for the user's latest message before supervisor routing.
GUARDRAILS_DETECTORS_INPUT_ONLY = {
    "input": {
        "gibberish-detector": {},
        "ibm-hate-and-profanity-detector": {},
        "prompt-injection-detector": {},
        "built-in-detector": {},
    },
    "output": {},
}

# Output screening for agent responses — uses input detectors on the
# agent's response text (sent as a single user message). We scan the
# text as "input" because the orchestrator scans the LLM's actual
# response for output detectors, not pre-existing text we provide.
# Gibberish detector excluded: agent responses with menu items, lists,
# and order summaries frequently trigger false positives.
GUARDRAILS_DETECTORS_OUTPUT_SCREEN = {
    "input": {
        "ibm-hate-and-profanity-detector": {},
        "built-in-detector": {},
    },
    "output": {},
}

# ============================================================
# Guardrails LLM instances (ChatOpenAI pointed at orchestrator)
# ============================================================
# Orchestrator does not support streaming (returns empty response)
# or "tool" role messages (422 error), so guardrails LLMs are
# non-streaming and agent nodes use regular agents with tools.

def _log_guardrails_response(response: httpx.Response) -> None:
    """httpx event hook — log detections/warnings from orchestrator responses."""
    response.read()
    try:
        data = response.json()
        if data.get("detections"):
            print(f"[guardrails] Detections: {json.dumps(data['detections'], indent=2)}", flush=True)
        if data.get("warnings"):
            print(f"[guardrails] Warnings: {json.dumps(data['warnings'], indent=2)}", flush=True)
    except Exception:
        pass

_guardrails_http_client = httpx.Client(event_hooks={"response": [_log_guardrails_response]})
_GUARDRAILS_LLM_COMMON = {**_LLM_COMMON, "streaming": False, "http_client": _guardrails_http_client}

if GUARDRAILS_URL:
    guardrails_llm = ChatOpenAI(
        base_url=GUARDRAILS_URL,
        extra_body={**_EXTRA_BODY, "detectors": GUARDRAILS_DETECTORS},
        **_GUARDRAILS_LLM_COMMON,
    )
    guardrails_llm_input_only = ChatOpenAI(
        base_url=GUARDRAILS_URL,
        extra_body={**_EXTRA_BODY, "detectors": GUARDRAILS_DETECTORS_INPUT_ONLY},
        **_GUARDRAILS_LLM_COMMON,
    )
    guardrails_llm_output_screen = ChatOpenAI(
        base_url=GUARDRAILS_URL,
        extra_body={**_EXTRA_BODY, "detectors": GUARDRAILS_DETECTORS_OUTPUT_SCREEN},
        **_GUARDRAILS_LLM_COMMON,
    )

# ============================================================
# Agent Creation
# ============================================================
supervisor_agent = create_react_agent(model=llm, tools=[])
order_agent = create_react_agent(model=llm, tools=[add_to_order])
pizza_agent = create_react_agent(model=llm, tools=[get_pizza_type])
delivery_agent = create_react_agent(model=llm, tools=[choose_delivery])

# Guardrails agents reuse the regular agents (with tools, regular LLM)
# because the orchestrator cannot handle "tool" role messages in the
# react agent loop. User input is already pre-screened before routing.
if GUARDRAILS_URL:
    g_supervisor_agent = create_react_agent(model=guardrails_llm, tools=[])


# ============================================================
# State and Models
# ============================================================
class SupervisorState(TypedDict, total=False):
    """State shared across all agents in the graph."""

    messages: Annotated[
        list, add_messages
    ]  # Conversation history (uses add_messages reducer)
    pizza_type: Annotated[str, "The type of pizza the user wants to order."]


class SupervisorDecision(BaseModel):
    """Structured output from supervisor for routing decisions."""

    next_agent: Literal["order_agent", "pizza_agent", "delivery_agent", "none"]
    pizza_type: Annotated[str, "The type of pizza the user wants to order."]
    response: str = ""  # Direct response if no routing needed


# ============================================================
# Helper Functions
# ============================================================
def _invoke_agent(agent, prompt: str, messages: list, agent_name: str):
    """Helper to invoke an agent and return formatted response.

    This consolidates the common pattern of:
    1. Adding system prompt to messages
    2. Invoking the agent subgraph
    3. Extracting and naming the response message
    """
    agent_input = {"messages": [SystemMessage(content=prompt)] + messages}
    agent_result = agent.invoke(agent_input)
    response_message = agent_result["messages"][-1]
    response_message.name = agent_name
    return response_message


def supervisor_command_node(state: SupervisorState) -> Command:
    """Supervisor for Command routing - uses structured output."""
    decision: SupervisorDecision = llm.with_structured_output(
        SupervisorDecision
    ).invoke([SystemMessage(content=SUPERVISOR_PROMPT)] + state["messages"])

    if decision.next_agent == "none":
        response = _invoke_agent(
            supervisor_agent, SUPERVISOR_PROMPT, state["messages"], "supervisor"
        )
        return Command(goto="__end__", update={"messages": [response]})

    update = {
        "messages": [
            AIMessage(content=f"Routing to {decision.next_agent}", name="supervisor")
        ]
    }

    if decision.pizza_type != "":
        update["pizza_type"] = decision.pizza_type
        print(f"Supervisor: Extracted pizza_type='{decision.pizza_type}'")

    print(f"Supervisor: Routing to {decision.next_agent}")
    return Command[str](goto=decision.next_agent, update=update)


def pizza_agent_node(state: SupervisorState) -> Command:
    """Pizza agent - chooses a pizza."""
    print("Pizza Agent")
    response = _invoke_agent(
        pizza_agent, PIZZA_AGENT_PROMPT, state["messages"], "pizza_agent",
    )
    print("Pizza Agent: routed to wait_for_user_after_pizza")
    return Command[str](
        goto="wait_for_user_after_pizza", update={"messages": [response]}
    )


def order_agent_node(state: SupervisorState) -> Command:
    """Order agent - adds items to the order."""
    print("Order Agent")
    response = _invoke_agent(
        order_agent, ORDER_AGENT_PROMPT, state["messages"], "order_agent",
    )
    print("Order Agent: routed to wait_for_user_after_order")
    return Command[str](
        goto="wait_for_user_after_order", update={"messages": [response]}
    )


def delivery_agent_node(state: SupervisorState) -> Command:
    """Delivery agent - chooses a delivery option and asks for the address."""
    print("Delivery Agent")
    response = _invoke_agent(
        delivery_agent, DELIVERY_AGENT_PROMPT, state["messages"], "delivery_agent",
    )
    print("Delivery Agent: routed to wait_for_user_after_delivery")
    return Command[str](
        goto="wait_for_user_after_delivery", update={"messages": [response]}
    )


def _interrupt_payload(state: SupervisorState, agent: str) -> dict:
    """Create a JSON-serializable interrupt payload for the UI."""
    last = state.get("messages", [])[-1] if state.get("messages") else None
    return {
        "agent": agent,
        "prompt": normalize_content_to_text(getattr(last, "content", ""))
        if last
        else "",
        "pizza_type": state.get("pizza_type", ""),
    }


def wait_for_user_after_pizza(state: SupervisorState) -> Command:
    """Interrupt after pizza agent, waiting for user's next input."""
    user_text = interrupt(_interrupt_payload(state, "pizza_agent"))
    return Command(
        goto="supervisor", update={"messages": [HumanMessage(content=str(user_text))]}
    )


def wait_for_user_after_order(state: SupervisorState) -> Command:
    """Interrupt after order agent, waiting for user's next input."""
    user_text = interrupt(_interrupt_payload(state, "order_agent"))
    return Command(
        goto="supervisor", update={"messages": [HumanMessage(content=str(user_text))]}
    )


def wait_for_user_after_delivery(state: SupervisorState) -> Command:
    """Interrupt after delivery agent, waiting for user's next input."""
    user_text = interrupt(_interrupt_payload(state, "delivery_agent"))
    return Command(
        goto="supervisor", update={"messages": [HumanMessage(content=str(user_text))]}
    )


GUARDRAILS_BLOCKED_MSG = "Unsuitable content detected, please rephrase your message."


def _guardrails_blocked_command() -> Command:
    """Return a Command that interrupts with the guardrails blocked message."""
    print("[guardrails] Content blocked by guardrails", flush=True)
    return Command(
        goto="wait_for_user_after_guardrails",
        update={"messages": [AIMessage(content=GUARDRAILS_BLOCKED_MSG, name="guardrails")]},
    )


def wait_for_user_after_guardrails(state: SupervisorState) -> Command:
    """Interrupt after guardrails block, waiting for user's next input."""
    user_text = interrupt(_interrupt_payload(state, "guardrails"))
    return Command(
        goto="supervisor", update={"messages": [HumanMessage(content=str(user_text))]}
    )


def _screen_user_input(messages: list) -> None:
    """Screen the user's latest message through guardrails input detectors.

    Sends only the latest user message (not full history) to avoid false
    positives from internal prompts. If blocked, the orchestrator returns
    empty choices and langchain raises an error.
    """
    last_user_msg = None
    for m in reversed(messages):
        if isinstance(m, HumanMessage):
            last_user_msg = m.content
            break
    if not last_user_msg:
        return

    guardrails_llm_input_only.invoke([HumanMessage(content=last_user_msg)])


def _screen_agent_output(response_text: str) -> None:
    """Screen an agent's response through guardrails detectors.

    Sends the agent's response as a single user message and scans it
    through input detectors (HAP, built-in). We use input detectors
    because the orchestrator's output detectors scan the LLM's live
    response, not pre-existing text we provide. Gibberish detector is
    excluded as agent responses with menu items and lists trigger
    false positives.
    """
    if not response_text:
        return

    guardrails_llm_output_screen.invoke([HumanMessage(content=response_text)])


def make_guardrails_nodes() -> dict:
    """Create node functions that route LLM calls through the guardrails orchestrator."""

    def g_supervisor_command_node(state: SupervisorState) -> Command:
        # Pre-screen user input before routing.
        try:
            _screen_user_input(state["messages"])
        except Exception as exc:
            print(f"[guardrails] User input blocked: {exc}", flush=True)
            return _guardrails_blocked_command()

        # Routing uses regular LLM (structured output, no guardrails).
        decision: SupervisorDecision = llm.with_structured_output(
            SupervisorDecision
        ).invoke([SystemMessage(content=SUPERVISOR_PROMPT)] + state["messages"])

        if decision.next_agent == "none":
            try:
                response = _invoke_agent(
                    g_supervisor_agent, SUPERVISOR_PROMPT, state["messages"], "supervisor"
                )
            except Exception as exc:
                print(f"[guardrails] Supervisor response blocked: {exc}", flush=True)
                return _guardrails_blocked_command()
            return Command(goto="__end__", update={"messages": [response]})

        update = {
            "messages": [
                AIMessage(content=f"Routing to {decision.next_agent}", name="supervisor")
            ]
        }
        if decision.pizza_type != "":
            update["pizza_type"] = decision.pizza_type
            print(f"Supervisor [guardrails]: Extracted pizza_type='{decision.pizza_type}'")
        print(f"Supervisor [guardrails]: Routing to {decision.next_agent}")
        return Command[str](goto=decision.next_agent, update=update)

    # Agent nodes use regular agents (with tools, regular LLM) because
    # the orchestrator rejects "tool" role messages (422: Last message
    # role must be user, assistant, or system). User input is already
    # pre-screened before routing.

    def g_pizza_agent_node(state: SupervisorState) -> Command:
        print("Pizza Agent [guardrails]")
        response = _invoke_agent(
            pizza_agent, PIZZA_AGENT_PROMPT, state["messages"], "pizza_agent"
        )
        try:
            _screen_agent_output(normalize_content_to_text(response.content))
        except Exception as exc:
            print(f"[guardrails] Pizza agent output blocked: {exc}", flush=True)
            return _guardrails_blocked_command()
        return Command[str](goto="wait_for_user_after_pizza", update={"messages": [response]})

    def g_order_agent_node(state: SupervisorState) -> Command:
        print("Order Agent [guardrails]")
        response = _invoke_agent(
            order_agent, ORDER_AGENT_PROMPT, state["messages"], "order_agent"
        )
        try:
            _screen_agent_output(normalize_content_to_text(response.content))
        except Exception as exc:
            print(f"[guardrails] Order agent output blocked: {exc}", flush=True)
            return _guardrails_blocked_command()
        return Command[str](goto="wait_for_user_after_order", update={"messages": [response]})

    def g_delivery_agent_node(state: SupervisorState) -> Command:
        print("Delivery Agent [guardrails]")
        response = _invoke_agent(
            delivery_agent, DELIVERY_AGENT_PROMPT, state["messages"], "delivery_agent"
        )
        try:
            _screen_agent_output(normalize_content_to_text(response.content))
        except Exception as exc:
            print(f"[guardrails] Delivery agent output blocked: {exc}", flush=True)
            return _guardrails_blocked_command()
        return Command[str](goto="wait_for_user_after_delivery", update={"messages": [response]})

    return {
        "supervisor": g_supervisor_command_node,
        "order_agent": g_order_agent_node,
        "pizza_agent": g_pizza_agent_node,
        "delivery_agent": g_delivery_agent_node,
    }
