# Optional features

The [README](../README.md#core-and-optional-pieces) shows the quick way to turn each feature off. This page lists what to edit to remove one completely. Delete a feature's tests along with it, then run the [checks](development.md#checks).

## Orb

Delete [Orb.tsx](../web/src/components/Orb.tsx) and [canvas-theme.ts](../web/src/lib/canvas-theme.ts), which only the orb uses. Then remove `<Orb>` and its import from [CallStage.tsx](../web/src/components/CallStage.tsx). The stage keeps its heading and status text centered without it.

## Spoken fillers

Removing the `speak_fillers(...)` call and its import from [pipeline.py](../src/agent/pipeline.py) stops them. To delete them completely:

- Move `SILENT` out of [fillers.py](../src/agent/fillers.py) before deleting that file if you keep the typing sound, which uses it to skip fast tools.
- Remove the filler handling in [tts.py](../src/services/tts.py) and [output.py](../src/transport/output.py), which gives fillers a shorter timeout and keeps them out of the conversation history. It does nothing once no fillers are queued, so leaving it is harmless.
- Remove the `filler_finished` event from [contracts.ts](../web/src/lib/contracts.ts) and [model.ts](../web/src/voice/model.ts).
- Delete `tests/server/test_fillers.py` and the filler cases in the audio output, tools, and client model tests.

## Typing sound

Setting `VOLUME = 0` in [thinking.py](../src/transport/thinking.py) silences it. To delete it completely:

- Delete `thinking.py`, [keyboard-typing.wav](../src/transport/keyboard-typing.wav), and `tests/server/test_thinking.py`.
- In [pipeline.py](../src/agent/pipeline.py), remove `ThinkingSound`, the `on_lookups_started` handler, and the `thinking` argument to the output.
- In [output.py](../src/transport/output.py), remove the `thinking` parameter, its three calls, and the `thinking_chunks` counter, plus the typing cases in the audio output tests.
- Remove the `.wav` rule from [wrangler.jsonc](../wrangler.jsonc) and the sound's credit from [NOTICE.md](../NOTICE.md#sounds).

To swap in a different sound instead, keep the `.wav` rule: Python Workers leave `.wav` files out of the bundle without it. The clip must be mono PCM16 at 48 kHz.

## Tools

The **Tools** checkbox in Settings turns off every tool for a call. Each tool is spread across several files, so remove these together:

- its service in [src/services](../src/services/) and its entry in `build_tools` in [tools.py](../src/agent/tools.py)
- its instructions in the system prompt in [config.py](../src/agent/config.py)
- its filler phrases in [fillers.py](../src/agent/fillers.py)
- its label in [conversation.ts](../web/src/voice/conversation.ts) and its [preview scenario](../web/src/preview/scenarios.ts), if it has one
- its mention in the **Tools** description in [AgentSettings.tsx](../web/src/components/AgentSettings.tsx) and in the README introduction
- its tests in `tests/server` and `tests/client`

Some tools share code. Cloudflare documentation is two tools, search and read a page, in `docs.py` and `docs_page.py`. Weather is two tools in `weather.py`, and its Open-Meteo credit appears in [NOTICE.md](../NOTICE.md#weather-data) and Settings. Web search also has provider settings in `config.py` and its own [payment setup](deployment.md#configure).

To add your own tools later, keep `tools.py` and its `tool_call()` wrapper. See [Add a tool](agent.md#add-a-tool).

## Read the core

These files make up the core, in order from the browser to the agent:

1. [call.ts](../web/src/voice/call.ts) and [peer.ts](../web/src/voice/peer.ts): the browser's side of the call, from the microphone to the WebRTC connection.
2. [entry.py](../src/entry.py) and [routes.py](../src/server/routes.py): Worker routing.
3. [call.py](../src/server/call.py) and [realtime.py](../src/server/realtime.py): the Durable Object that owns one call, and its SFU session and WebSocket adapters.
4. [engine.py](../src/agent/engine.py) and [codec.py](../src/transport/codec.py): the adapter sockets, and conversion between SFU packets and PCM audio.
5. [pipeline.py](../src/agent/pipeline.py): the conversation harness.
6. [flux.py](../src/services/flux.py), [llm.py](../src/services/llm.py), and [tts.py](../src/services/tts.py): Workers AI speech recognition and turn detection, the language model, and speech synthesis.
7. [output.py](../src/transport/output.py) and [playback.py](../src/transport/playback.py): ordering and pacing the agent's audio, including when the caller interrupts.
8. [speech_history.py](../src/agent/speech_history.py): how much of an interrupted reply the model remembers.
