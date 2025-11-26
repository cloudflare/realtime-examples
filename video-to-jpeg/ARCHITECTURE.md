# Architecture and Technical Details

This document provides in-depth technical information about the video-to-jpeg demo's architecture, API flows, and implementation details.

## High-level Architecture

### Components

- **Cloudflare Worker** (`src/index.ts`)
  - Routes requests based on `/<session>/...`.
  - Serves the static HTML UI from `src/player.html`.
  - Forwards all `/⟨session⟩/video/*` requests to the `VideoAdapter` Durable Object instance derived from `session`.

- **`VideoAdapter` Durable Object** (`src/video-adapter.ts`)
  - Owns the state for a single `session` name:
    - Realtime SFU session ID.
    - Video track name.
    - WebSocket adapter ID.
  - HTTP endpoints:
    - `POST /⟨session⟩/video/connect` — create SFU session, publish video via `autoDiscover`.
    - `POST /⟨session⟩/video/start-forwarding` — configure a WebSocket adapter with `outputCodec: "jpeg"`.
    - `POST /⟨session⟩/video/stop-forwarding` — close the adapter (idempotent).
  - WebSocket endpoints:
    - `WS /⟨session⟩/video/sfu-subscribe` — SFU → DO, receives `Packet` messages containing JPEG payloads.
    - `WS /⟨session⟩/video/viewer` — DO → browsers, fans out raw JPEG payloads to viewers.

- **SFU helper** (`src/shared/sfu-utils.ts`)
  - Wraps Realtime SFU REST API calls:
    - `createSession()`
    - `addTracksAutoDiscoverForVideo()`
    - `pullTrackToWebSocket()` (with `outputCodec: "jpeg"`)
    - `closeWebSocketAdapter()`
  - Knows how to decode the `Packet` protobuf and extract JPEG payloads.

- **Frontend app** (`src/web/app.ts`)
  - Publisher:
    - WebRTC offer/answer negotiation with the SFU via the Worker.
    - Controls start/stop of JPEG streaming via adapter endpoints.
    - Renders local camera video and snapshots.
  - Viewer:
    - Connects to the viewer WebSocket and renders the JPEG frames.

## Publisher Workflow (Detailed)

When you click buttons on the **publisher** page, here's what happens under the hood:

### 1. Connect Camera

1. The browser requests camera access via `getUserMedia`.
2. A `RTCPeerConnection` is created with your camera tracks.
3. The frontend sends an SDP offer to the Worker:
   - `POST /my-session/video/connect` with `{ sessionDescription: offer }`.
4. The `VideoAdapter` Durable Object:
   - Creates an SFU session via `POST /v1/apps/{appId}/sessions/new`.
   - Publishes your track via `autoDiscover` onto that session.
   - Returns an SFU answer, which the frontend sets as the remote description.

### 2. Start JPEG Stream

1. Frontend calls `POST /my-session/video/start-forwarding`.
2. `VideoAdapter` configures a **WebSocket adapter** with:
   - `location: "remote"`
   - `sessionId: <publisher-sfu-session-id>`
   - `trackName: <video-track-name>`
   - `endpoint: wss://.../my-session/video/sfu-subscribe`
   - `outputCodec: "jpeg"`
3. The Realtime SFU starts sending JPEG frames (~1 FPS) to the Durable Object over WebSocket.
4. The publisher page opens a viewer WebSocket as well (same as the viewer page) and shows the JPEG snapshots.

### 3. Stop JPEG Stream

- Frontend calls `POST /my-session/video/stop-forwarding`.
- `VideoAdapter` closes the WebSocket adapter via the Realtime SFU API.

## Viewer Workflow (Detailed)

On the **viewer** page (`/my-session/viewer`):

1. The frontend opens a WebSocket to:
   ```
   ws(s)://<host>/my-session/video/viewer
   ```

2. The `VideoAdapter`:
   - Receives each adapter frame as a `Packet` protobuf from the SFU.
   - Extracts the JPEG `payload`.
   - Broadcasts the JPEG bytes to all connected viewer sockets.

3. The browser receives each message as a binary `Blob`, wraps it in an `ObjectURL`, and assigns it to an `<img>` element.

If a viewer connects late, the `VideoAdapter` sends the **last stored frame** immediately upon connection so the UI shows something even before the next snapshot arrives.

## API Routes Reference

### UI pages

- `GET /⟨session⟩/publisher` — Publisher interface with camera controls
- `GET /⟨session⟩/viewer` — Viewer interface showing JPEG stream

### HTTP endpoints (VideoAdapter)

- `POST /⟨session⟩/video/connect` — Create SFU session and publish camera
- `POST /⟨session⟩/video/start-forwarding` — Start WebSocket adapter with JPEG output
- `POST /⟨session⟩/video/stop-forwarding` — Stop adapter and close connection

### WebSocket endpoints

- `WS /⟨session⟩/video/sfu-subscribe` — SFU → Durable Object (JPEG `Packet` messages)
- `WS /⟨session⟩/video/viewer` — Durable Object → browsers (raw JPEG bytes)

### Debug endpoints

- `DELETE /⟨session⟩` — Calls `VideoAdapter.destroy()` to close all sockets and wipe state for that session. This is unauthenticated for demo purposes; add authentication before using in production.

## Protobuf Message Format

The WebSocket adapter sends video frames as protobuf `Packet` messages:

```proto
syntax = "proto3";

message Packet {
    uint32 sequenceNumber = 1; // sequence number (used for audio; may be unset for video)
    uint32 timestamp = 2;       // timestamp for synchronization
    bytes payload = 5;          // media payload (PCM audio or JPEG video)
}
```

For JPEG video, the `payload` field contains the raw JPEG image bytes, which can be directly rendered in a browser `<img>` element or processed further.

## Durable Object State Persistence

The `VideoAdapter` persists the following state across requests:

- `sfuSessionId` — The Realtime SFU session ID
- `videoTrackName` — The name of the published video track
- `sfuAdapterId` — The WebSocket adapter ID (if active)
- `sessionName` — Human-readable session identifier

This state is stored in Durable Object storage and survives Worker restarts. The "Reset Session" button calls `DELETE /<session>` to clear this state.

## Video Processing Pipeline

```
Camera (Browser)
    ↓ WebRTC
Realtime SFU
    ↓ WebSocket Adapter (outputCodec: "jpeg")
VideoAdapter Durable Object
    ↓ WebSocket (binary JPEG)
Viewer Browsers
```

The Realtime SFU transcodes the incoming video stream to JPEG at approximately 1 FPS and sends each frame as a protobuf `Packet` to the Durable Object, which broadcasts it to all connected viewers.
