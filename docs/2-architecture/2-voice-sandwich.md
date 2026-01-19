# Voice Sandwich

Building the voice sandwich for ourselves.

![./images/voice-sandwich.png](images/voice-sandwich.png)

![./images/voice-sandwich-components.png](images/voice-sandwich-components.png)

Build a voice agent with LangChain
- https://www.youtube.com/watch?v=kDPzdyX76cg
- https://github.com/langchain-ai/voice-sandwich-demo

Current stack:
- Python server
- Next.js client
- Langchain agents SDK
- Llama Stack for Observability (optional)
- Web Sockets for client-server
- RHOAI 3.x Platform in AWS for hosting

Simplifications:
- no VAD (input speech button)
- using web sockets for client-server comms (WebRTC is a more complex alternative)
