# TTSAdapter State Machines (src/tts-adapter.ts)

This document maps the behaviors of the TTS Durable Object into orthogonal state machines and shows how endpoints and events drive transitions.

- File: `src/tts-adapter.ts`
- Primary responsibilities:
  - Generate audio via Cloudflare AI Deepgram Aura TTS (WebSocket-first, HTTP fallback)
  - Maintain a persistent Aura WebSocket with reconnection gating and unified alarms
  - Encode and stream PCM to the SFU as `Packet` frames in real time
  - Buffer final audio for late joiners and signal end-of-stream correctly
  - Provide simple publish/connect lifecycle to expose the generated audio via the SFU

## Key Functions / Areas

- WebSocket to SFU (clients): `handleSubscribe()`, `webSocketClose()`, `webSocketError()`, `sendBufferInChunks()`
- Publish/connect lifecycle: `handlePublish()`, `handleUnpublish()`, `handleConnect()`
- Generation API: `handleGenerate()`, `processGenerateRequest()`, `generateAndBroadcastAudio()`
- Aura WS lifecycle: `getOrCreateAuraConnection()`, `connectToAura()`, `closeAuraConnection()`, `scheduleTTSAuraReconnect()`, `setupAuraMessageHandlers()`, `handleAuraMessage()`
  - Uses shared `dedupedConnect()` from `src/shared/ws-connection.ts` to prevent concurrent connection attempts
- Streaming + processing: `streamChunkToClients()`, `finalizeAudioStream()`, `processTTSUsingSpeexOrFallback()`, `encodePcmForSfu()`
- Alarms + deadlines: `scheduleInactivity()`, `scheduleInactivityIfIdle()`, `cancelInactivity()`, `alarm()`; alarm scheduling is handled by the shared `stateStore` implicitly on `update()`/`deleteKeys()`.
- Init safety: constructor + `this.ctx.blockConcurrencyWhile(() => restoreState())`

---

## State Machines

### 1) Client Occupancy (connected Durable-Object WebSockets)

States:
- `None`
- `One` (exactly 1 SFU client subscribed, enforced via replacement)

Events/Transitions:
- SFU client connect → `handleSubscribe()` 
  - Enforces single subscriber: accepts new socket, closes any existing sockets with code 1000 "Superseded by newer subscriber"
  - Late joiners get buffered audio if present
- On WS close → `webSocketClose()`
  - Schedules `cleanupDeadline` (100ms delay) for deferred last-client check via alarm
  - No immediate cleanup due to DO timing issues

ASCII:
```
            +-------+
            | None  |
            +-------+
               | WS open (handleSubscribe)
               v
            +-------+
            | One   |  <-- enforced via replacement
            +-------+
               |
               | WS close triggers cleanupDeadline
               v
         [alarm check after 100ms]
               |
               | if openCount == 0:
               v
            +-------+
            | None  | (last-client cleanup executed)
            +-------+
```

---

### 2) Aura TTS WebSocket Lifecycle (pre-create + reconnect gating)

States:
- `Disconnected`
- `Connecting`
- `Connected`

Events/Transitions:
- On publish: store speaker and enable `allowReconnect = true`; try to pre-create via `getOrCreateAuraConnection()`
- On generate: `generateAudioAuraWebSocket()` ensures a connection; sends `{type:'Speak'}` then `{type:'Flush'}`
- On WS `'close'`: if `allowReconnect` and attempts < max → `scheduleTTSAuraReconnect()`
- On unpublish: disable reconnect, `closeAuraConnection()`, clear state

ASCII:
```
+--------------+   getOrCreateAuraConnection    +------------+
| Disconnected | -----------------------------> | Connecting |
+--------------+                                +------------+
       ^                                               |
       |   close / error                               | on open
       |                                               v
       |                                         +------------+
       +-----------------------------------------| Connected  |
                                                 +------------+
On WS close:
- if allowReconnect and attempts < max: scheduleTTSAuraReconnect()
- else remain Disconnected
```

---

### 3) TTS Streaming + Finalization

States:
- `Idle` (not streaming)
- `Streaming` (receiving chunks from Aura)
- `Finalizing` (after receiving `Flushed`)

Events/Transitions:
- Start: `generateAudioAuraWebSocket(text)` sends `Speak` → `Flush`
- On each audio chunk: `handleAuraMessage(ArrayBuffer)` → `audioStreamBuffer.push()` → `streamChunkToClients()` (24k→48k resample + mono→stereo)
- On `Flushed`: `finalizeAudioStream()`
  - Send end-of-stream empty packet to all clients
  - Merge buffered chunks → `stereoAudioBuffer` for late joiners
  - `scheduleInactivity('finalize')`

ASCII:
```
     Speak/Flush          audio chunk            Flushed
+-----------+   --->   +-----------+   --->   +-----------+
|   Idle    |          | Streaming |          | Finalizing|
+-----------+  <---    +-----------+  <---    +-----------+
     no chunks             drained                done
```

---

### 4) Unified Alarms (Cleanup + Reconnect + Inactivity)

States:
- `AlarmOff` (no deadlines)
- `AlarmOn` (earliest of cleanup vs inactivity vs reconnect deadlines)

Events/Transitions:
- Set cleanup: `webSocketClose()` → writes `cleanupDeadline = now + 100ms` for deferred last-client check
- Set inactivity: `scheduleInactivity(reason)` → writes `inactivityDeadline` (state store auto-reschedules alarm)
- Set reconnect: `scheduleTTSAuraReconnect()` → writes `reconnectDeadline` and increments attempts
- Alarm fires: `alarm()`
  - If cleanup due: count open sockets (`readyState === OPEN`); if 0, perform last-client cleanup; else clear deadline
  - Else if inactivity due: delete deadline; `closeAuraConnection()`; `disconnectAll()`
  - Else if reconnect due: if allowed and attempts ≤ max, try `getOrCreateAuraConnection()`; on failure, call `scheduleTTSAuraReconnect()` to back off
  - Alarm scheduling is handled by the state store based on current deadlines

ASCII:
```
+-----------+  set cleanup/inactivity/reconnect  +-----------+
| AlarmOff  | ---------------------------------> | AlarmOn   |
+-----------+                                    +-----------+
     ^                                                |
     | stateStore auto-reschedule after updates       v
     +------------------------------------------------+
```

---

## Endpoint Effects (Summary)

- `POST /<sid>/publish`
  - **Single publish guard**: If `adapterId` already exists, reject with 409 "Session is already published"
  - Persist selected `speaker`, enable reconnects, register SFU WebSocket adapter with callback `/<sid>/subscribe`
  - Store `sfuSessionId`, `adapterId`; `scheduleInactivity('publish')`
  - Attempt to pre-create Aura WS for faster first synthesis

- `POST /<sid>/unpublish`
  - Close SFU adapter; **Idempotent**: If SFU returns 503 with `errorCode: "adapter_not_found"`, treats as success and proceeds with cleanup
  - `closeAuraConnection()`; `disconnectAll()` to proactively close DO clients
  - Clear `sfuSessionId`, `adapterId`, `selectedSpeaker`, `cleanupDeadline`; clear buffer

- `POST /<sid>/connect`
  - Create a new SFU session for the listener and pull `trackName=<sid>` from publisher `sessionId`

- `WS /<sid>/subscribe`
  - **Single subscriber enforcement**: Accept new SFU client; close any existing sockets (1000, "Superseded by newer subscriber")
  - If `stereoAudioBuffer` exists, send immediately in chunks and then an empty packet as end-of-stream

- `POST /<sid>/generate`
  - Start WebSocket-based synthesis (Speak + Flush). Streams audio chunks in real time to SFU clients
  - On failure, fallback to HTTP TTS, process and broadcast the resulting buffer
  - Always resets inactivity deadline (`scheduleInactivity('generate')`)

- `DELETE /<sid>` (debug, Worker root)
  - Routed by `src/index.ts` (not under `/tts`)
  - Calls both adapters' `destroy()` concurrently
  - TTS effects: closes Aura WS, closes all DO WebSocket clients, clears buffers, cancels alarms, wipes all persisted state
  - Security: unauthenticated in this demo; add auth in production

---

## Notes

- __Single subscriber model__: Only one SFU WebSocket adapter can connect to the DO at a time.
  - **1:1 mapping**: Each publish creates exactly one SFU adapter, enforced at both publish and subscribe time.
  - **Replace policy**: New subscribers replace existing ones to handle reconnection races gracefully.
  - **Fan-out unaffected**: The `/connect` endpoint still allows unlimited listeners via SFU-to-SFU pull.

- __DO timing safety__: `webSocketClose()` schedules a deferred cleanup check (100ms) via `cleanupDeadline`.
  - The `alarm()` handler verifies `readyState === OPEN` count before deciding on last-client cleanup.
  - Avoids race conditions where `getWebSockets()` may not immediately reflect closed sockets.

- __Audio processing__: Aura LINEAR16 produces 24kHz mono PCM.
  - Prefer SpeexDSP (WASM) for 24k→48k upsample, then `AudioProcessor.monoToStereo()`.
  - Fallback JS pipeline: `AudioProcessor.processForTTS()`.
  - Even-byte safeguard enforced before processing.

- __Packet format__: Uses `Packet.toBinary()` (via `encodePcmForSfu()`) with payload-only semantics for SFU adapter in buffer mode.
  - Sends an empty packet (`new ArrayBuffer(0)`) to signal end-of-stream to clients.

- __Security__: Aura WebSocket uses `fetch()` with Upgrade to include `Authorization: Bearer <token>` (no secrets in browser).

- __Hibernation__: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'))` avoids waking the DO on pings.

- __Reconnect gating__: Controlled by `allowReconnect` and `maxReconnectAttempts`.
  - Enabled on publish; disabled on unpublish and when last client closes.
  - When a reconnect deadline fires, `alarm()` attempts to reconnect; on failure it calls `scheduleTTSAuraReconnect()` to schedule the next backoff attempt. Alarm rescheduling is performed by the state store.

- __Late joiners__: `stereoAudioBuffer` retains last finalized stream so `handleSubscribe()` can immediately replay it for new clients.
