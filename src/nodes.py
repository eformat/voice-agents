"""Node functions for supervisor and specialist agents."""

from __future__ import annotations

import os
from typing import Annotated, Literal

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph.message import add_messages
from langgraph.types import Command
from pydantic import BaseModel
from typing_extensions import TypedDict

from src.prompts import (
    SUPERVISOR_PROMPT,
    TEXT_TO_SPEECH_AGENT_PROMPT,
)
from src.tools import (
    convert_text_to_speech,
)

load_dotenv()

MODEL_NAME = os.getenv("MODEL_NAME", "MODEL_NAME")
BASE_URL = os.getenv("BASE_URL", "BASE_URL")
API_KEY = os.getenv("API_KEY", "API_KEY")

llm = ChatOpenAI(
    streaming=True,
    model=MODEL_NAME,
    temperature=0.2,
    max_retries=2,
    timeout=30,
    base_url=BASE_URL,
    api_key=API_KEY,
)

# ============================================================
# Configuration
# ============================================================
TEMPERATURE = 0.0

# ============================================================
# Agent Creation
# ============================================================
# Create agents with domain-specific tools using create_agent
# Each agent is a compiled subgraph that can invoke tools during reasoning
supervisor_agent = create_agent(
    model=llm,  # init_chat_model(MODEL_NAME, temperature=TEMPERATURE),
    tools=[],  # No tools needed for supervisor
)

text_to_speech_agent = create_agent(
    model=llm,  # init_chat_model(MODEL_NAME, temperature=TEMPERATURE),
    tools=[convert_text_to_speech],  # Text to speech converter
)


# ============================================================
# State and Models
# ============================================================
class SupervisorState(TypedDict, total=False):
    """State shared across all agents in the graph."""

    messages: Annotated[
        list, add_messages
    ]  # Conversation history (uses add_messages reducer)


class SupervisorDecision(BaseModel):
    """Structured output from supervisor for routing decisions."""

    next_agent: Literal["text_to_speech_agent", "none"]
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


# ============================================================
# Node Functions
# ============================================================
def supervisor_command_node(state: SupervisorState) -> Command:
    """Supervisor for Command routing - uses structured output."""
    # Use structured output to get routing decision
    decision: SupervisorDecision = llm.with_structured_output(
        SupervisorDecision
    ).invoke([SystemMessage(content=SUPERVISOR_PROMPT)] + state["messages"])

    # Handle direct response (no routing needed - e.g., greetings)
    if decision.next_agent == "none":
        response = _invoke_agent(
            supervisor_agent, SUPERVISOR_PROMPT, state["messages"], "supervisor"
        )
        return Command(goto="__end__", update={"messages": [response]})

    # Route to specialist agent
    update = {
        "messages": [
            AIMessage(content=f"Routing to {decision.next_agent}", name="supervisor")
        ]
    }
    print(f"Supervisor: Routing to {decision.next_agent}")
    return Command[str](goto=decision.next_agent, update=update)


def text_to_speech_agent_node(state: SupervisorState) -> Command:
    """Text to speech specialist - converts text to speech."""
    # Invoke agent and return Command to end
    print("Text to Speech Agent")
    response = _invoke_agent(
        text_to_speech_agent,
        TEXT_TO_SPEECH_AGENT_PROMPT,
        state["messages"],
        "text_to_speech_agent",
    )
    print("Text to Speech Agent: routed to __end__")
    return Command[str](goto="__end__", update={"messages": [response]})
