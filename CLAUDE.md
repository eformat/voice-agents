# Voice Agents

AI voice agent demo built on LangGraph with TrustyAI Guardrails integration.

## Project Structure

```
ai-voice-agent/
  backend/          Python WebSocket server (LangGraph agent graph)
  frontend/         React/Next.js UI
  deploy/chart/     Helm chart for OpenShift deployment
  guardrails/       Kustomize resources for TrustyAI Guardrails Orchestrator
```

## Guardrails

When `GUARDRAILS_URL` is set, the backend creates `ChatOpenAI` instances pointed at the orchestrator via the nginx proxy. Detectors are passed in `extra_body`. A custom `httpx` event hook logs detection results and warnings from every orchestrator response to both stdout and MLFlow traces (via `threading.local()` → `mlflow.get_current_active_span().set_attribute()`).

### Orchestrator limitations

- **No streaming** — returns empty response for `stream: true`. All guardrails LLMs use `streaming=False`.
- **No `tool` role messages** — rejects with 422. Agent nodes use regular agents (with tools, regular LLM) and screen output separately.

### Screening flow

1. **`_screen_user_input`** — pre-screens the user's raw message with all four input detectors (`GUARDRAILS_DETECTORS_INPUT_ONLY`) before supervisor routing. Only the single user message is sent to avoid false positives from system prompts.
2. **Supervisor routing** — regular LLM with structured output (no guardrails).
3. **Supervisor direct response** (route=none) — `guardrails_llm` with full input+output detectors (`GUARDRAILS_DETECTORS`).
4. **Agent nodes** (pizza, order, delivery) — regular agents with tools (regular LLM). Orchestrator can't handle `tool` role messages in the react agent loop.
5. **`_screen_agent_output`** — post-screens the agent's response text with HAP and built-in detectors (`GUARDRAILS_DETECTORS_OUTPUT_SCREEN`). Gibberish excluded (false positives on menu item lists).

### Detector notes

- **Prompt injection** — `protectai/deberta-v3-base-prompt-injection-v2` (DeBERTa, 184M params, 22 datasets). Replaced `jackhhao/jailbreak-classifier` which was poorly calibrated.
- **False positives on system prompts** — gibberish, built-in, and prompt-injection detectors all trigger on agent system prompts (the SECURITY section contains "ignore previous instructions" which triggers DeBERTa). This is why agents use regular LLMs and screening is done on isolated message text.
