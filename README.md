# voice-agents

A voice agent demo simulating "Pizza Palace" - ordering a pizza.

- RedHat AI Platform
- Open Source models
  - Speech to text using whisper LLM
  - Text to speech using higgs-audio LLM
  - Supervisor using llama-4-scout LLM (maas)
- Agent handoffs using Langchain + Langgraph
- Next.js web ui using websockets
- Python websocket server backend


## 🏃‍♀️ Running the docs site

If you have Node installed, you can start the site with the following command from within the `top directory of the git repo` directory:

```bash
npm i docsify-cli -g
docsify serve docs/
```
