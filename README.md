# Cloudflare Realtime Examples

Build custom audio, video, and low-latency data applications with Cloudflare
Realtime SFU and TURN.

The [Realtime SFU documentation](https://developers.cloudflare.com/realtime/sfu/)
explains the product and API primitives. Use this repository to run an
application, understand how its media and data move through Realtime, and adapt
the same architecture to your product.

## Best places to start

### Process live video in a Worker

Start with [`video-to-jpeg/`](video-to-jpeg/). After deployment, a browser
publishes camera video through Realtime SFU. A WebSocket media adapter converts
the video to JPEG frames for processing and viewing in a Worker.

This example keeps the Realtime SFU credential on the server. Its publisher and
administrative operations still need application authorization.

### Build an AI audio pipeline

Start with [`ai-tts-stt/`](ai-tts-stt/). After deployment, one browser publishes
microphone audio for speech recognition, while generated speech is broadcast to
connected listeners.

This example keeps Realtime SFU and Workers AI credentials on the server. Its
public control and cleanup operations still need application authorization.

## Explore by goal

| Goal | Start with | What it demonstrates | Status |
| --- | --- | --- | --- |
| Process WebRTC video | [`video-to-jpeg/`](video-to-jpeg/) | Browser video, a Worker, a Durable Object, and a WebSocket media adapter | Experimental |
| Build speech applications | [`ai-tts-stt/`](ai-tts-stt/) | Speech recognition, generated audio, Workers AI, and bidirectional adapters | Experimental |
| Broadcast generated speech | [`tts-ws/`](tts-ws/) | An external text-to-speech provider and Realtime SFU fanout | Experimental |
| Learn media publishing | [`echo/`](echo/) | Low-level audio and video track operations | Legacy |
| Learn DataChannel delivery | [`echo-datachannels/`](echo-datachannels/) | Reliability, `waitForAck`, `canReply`, and teardown through a server boundary | Experimental |
| Learn simulcast | [`echo-simulcast/`](echo-simulcast/) | Multiple video layers and subscriber layer selection | Legacy |
| Connect a WebRTC model | [`openai-webrtc-relay/`](openai-webrtc-relay/) | Browser and model PeerConnections joined through Realtime SFU | Legacy |
| Combine Realtime SFU and TURN | [`sfu-turn-go/`](sfu-turn-go/) | Pion, TURN relay transport, and Realtime SFU DataChannels | Legacy |
| Test TURN relay transport | [`turn-go/`](turn-go/) | Two Pion PeerConnections using Cloudflare TURN | Legacy |
| Ingest and play a broadcast | [`whip-whep-server/`](whip-whep-server/) | WHIP ingest, WHEP playback, a Worker, and a Durable Object | Legacy |

The [machine-readable catalog](catalog.yaml) records difficulty, components,
credential location, demo and architecture links, measured setup time when
available, and known limitations.

## Application blueprints

Blueprints are complete application starting points. Each blueprint includes a
deployable application, an architecture diagram, browser and server code,
security boundaries, reconnect and cleanup behavior, troubleshooting, and
reproducible checks.

We are currently building the first application blueprints. In the meantime,
start with the examples above.

Use a blueprint to:

1. Deploy the documented application.
2. Observe the intended media or data flow.
3. Inspect the Realtime SFU operations and application state.
4. Adapt the implementation while preserving its documented boundaries.

All blueprints live under [`blueprints/`](blueprints/). Existing example
directories remain available. When a blueprint replaces an older example, the
old directory points developers to the current implementation.

## Keep credentials safe

Never place a Realtime SFU bearer token in browser source, generated browser
assets, public variables, URLs, or logs.

The application backend stores provider credentials and makes Realtime SFU API
requests. It also decides who can publish, subscribe, control resources, or
perform destructive operations. Session names, track IDs, and URLs identify
resources; they do not authorize access.

Some examples intentionally allow anonymous viewing or demo control. Each
README identifies these limitations and the boundary an application must add.

## Example status

- **Maintained**: Actively owned, current with the documented API, and covered
  by its declared checks.
- **Experimental**: A working application under active development. Review its
  known limitations before adapting it.
- **Legacy**: A focused or historical example retained for learning and
  existing links. Follow its safety warning before running it.

Status describes the repository implementation. It does not certify that an
application fits every production environment.

## For contributors and coding agents

Keep the human-facing README and `catalog.yaml` consistent. Add complete
application blueprints under `blueprints/`, preserve existing example
directories, and keep known limitations next to the implementation.

Run the repository checks before submitting a change:

```bash
npm ci
npm run check
```

The checks validate catalog and blueprint metadata, local documentation links,
likely credentials in source, and browser assets declared by active blueprints.
