# Pipecat voice agent

> Example status: **Experimental**

A browser voice agent built with Cloudflare Workers, Realtime SFU, and Pipecat. The interface uses React 19 and Tailwind CSS 4.

You can interrupt the agent while it's talking, and it remembers facts you give it during the call. Settings let you change its name, voice, and instructions, and turn on tools for the current time, [weather and forecasts](https://open-meteo.com/), [Cloudflare documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/), [public service status](https://www.cloudflarestatus.com/), and [web search](https://developers.cloudflare.com/web-search/). Transcripts, tool status, and source links appear in the conversation.

[![Matt speaking during a call, with the orb lit beside a conversation that shows a web search, its source links, and the reply.](docs/voice-agent.png)](docs/voice-agent.png)

## Architecture

Each call runs in a Python Durable Object. Workers AI handles speech recognition, turn detection, language generation, and speech synthesis, and the SFU carries the audio.

```mermaid
flowchart LR
  Browser <-->|WebRTC audio| SFU[Realtime SFU]
  SFU <-->|WebSocket adapters| Agent[Python Durable Object / Pipecat]
  Agent <--> AI[Workers AI: STT, LLM, TTS]
  Agent <-->|HTTPS tools| Tools[Open-Meteo / Cloudflare Docs / Public status]
  Agent <-->|AI binding| Search[AI Gateway / Web Search]
  Browser <-->|HTTPS signaling and events| Agent
```

## Core and optional pieces

The core is the conversation harness, which starts in [pipeline.py](src/agent/pipeline.py). It listens to the caller, waits until they finish speaking, asks the model for a reply, and speaks it back, stopping if the caller interrupts.

Everything in this table builds on the harness and turns off with a small change. To remove a piece completely, see [Optional features](docs/optional-features.md), which lists every file it touches.

| Piece          | What it does                                                    | To turn it off                                                                                                                                    |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orb            | Animated globe that reacts to both voices                       | Remove `<Orb>` and its import from [CallStage.tsx](web/src/components/CallStage.tsx)                                                              |
| Spoken fillers | Short phrases such as "Let me check the docs" while a tool runs | Remove the `speak_fillers(...)` call and its import from [pipeline.py](src/agent/pipeline.py)                                                     |
| Typing sound   | Quiet keyboard typing during a slow lookup                      | Set `VOLUME = 0` in [thinking.py](src/transport/thinking.py)                                                                                      |
| Tools          | Time, weather, Cloudflare docs, status, and web search          | Clear **Tools** in Settings, or default `tools_enabled` to false in [config.py](src/agent/config.py) and [contracts.ts](web/src/lib/contracts.ts) |

## Try it

Preview the interface with the Node.js version in [.nvmrc](.nvmrc):

```sh
cd pipecat-voice-agent
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. This opens an interface preview with sample conversations, so you can work on the design without making a call. It needs no credentials or microphone, and it isn't included in the deployed app. To make real calls, follow the [deployment guide](docs/deployment.md).

A headset helps with interruptions because it keeps the assistant's voice out of your microphone.

## Known limitations

- A call can take a few seconds to connect while the agent starts and the SFU attaches its audio streams.
- Calls don't resume after a Worker restart or a browser disconnect, and each call starts with a fresh conversation history.
- Everyone signs in with one shared access code. Use an [identity provider](docs/authentication.md) for individual access and revocation.
- The SFU must reach the `/media/` adapter endpoints without a login challenge, so accounts that require Cloudflare Access on every endpoint can't host it.
- The default model requires Workers Paid, and Web Search needs its own AI Gateway payment setup.
- The bundled Pipecat build relies on hosted AI services and Flux turn detection; local VAD and Smart Turn aren't available. See [package compatibility](vendor/README.md).

## Guides

| Task                                | Guide                                             |
| ----------------------------------- | ------------------------------------------------- |
| Configure credentials and deploy    | [Deployment](docs/deployment.md)                  |
| Work locally and run checks         | [Development](docs/development.md)                |
| Customize the agent and add tools   | [Agent and tools](docs/agent.md)                  |
| Remove optional features            | [Optional features](docs/optional-features.md)    |
| Use another authentication provider | [Authentication](docs/authentication.md)          |
| Work on the interface               | [Design system](DESIGN.md)                        |
| Maintain Python dependencies        | [Workers package compatibility](vendor/README.md) |

Licensed under [MIT](LICENSE). See [third-party notices and data attribution](NOTICE.md).
