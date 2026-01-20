## Pizza Order Voice Flow (Start Recording → Stop & Send)

This diagram focuses on the main voice path: the user records audio in the browser, the UI sends the WAV to the Python WebSocket server, the server runs STT + the agent graph, then streams TTS audio back to the browser for playback.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant UI as Next.js UI (web/src/app/page.tsx)
  participant WS as WS Server (ws_server.py)
  participant STT as STT Endpoint
  participant Graph as LangGraph + Agents
  participant TTS as TTS Stream (OpenAI-compatible)

  User->>UI: Start Recording
  UI->>UI: getUserMedia() + ScriptProcessor capture
  User->>UI: Stop & Send
  UI->>UI: Build WAV (pcmToWavBlob)
  UI->>WS: JSON {type:"audio_wav_b64", audio_b64:...}

  WS->>STT: convert_speech_to_text(audio_bytes)
  STT-->>WS: transcript text
  WS-->>UI: JSON {type:"transcript", text}

  WS->>Graph: GRAPH.invoke(messages + transcript)
  Graph-->>WS: graph_result (messages, pizza_type, interrupt)
  WS-->>UI: JSON {type:"graph_result", ...}

  WS->>TTS: stream_tts_pcm_chunks(text)
  WS-->>UI: JSON {type:"tts_begin", format:"pcm_s16le", sample_rate}
  WS-->>UI: binary PCM frames (ArrayBuffer)
  WS-->>UI: JSON {type:"tts_end"}

  UI->>UI: AudioWorklet + SharedArrayBuffer playback
```
