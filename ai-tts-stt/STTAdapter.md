# STTAdapter State Machines (src/stt-adapter.ts)

This document maps the behaviors of the STT Durable Object into orthogonal state machines and shows how endpoints and events drive transitions.

- File: `src/stt-adapter.ts`
- Primary responsibilities:
  - Receive SFU audio (`WS /<sid>/stt/sfu-subscribe`), process PCM 48k stereo → 16k mono
  - Maintain a persistent Cloudflare AI Deepgram Nova STT WebSocket (pre-warm, reconnect gating, cleanup)
  - Manage a forwarding adapter (`/start-forwarding`, `/stop-forwarding`) between SFU and this DO
  - Broadcast transcriptions to connected clients (`WS /<sid>/stt/transcription-stream`)
  - Unify alarms for reconnect and inactivity cleanup
  - FIFO queue incoming audio and finalize streams correctly

## Key Functions / Areas

- WebSocket setup: `handleSFUSubscribe()`, `handleTranscriptionStream()`, `webSocketClose()`, `webSocketMessage()`
- Mic publish: `handleSTTConnect()` (pre-warm Nova)
- Forwarding lifecycle: `handleStartForwarding()`, `handleStopForwarding()`
- Nova WS lifecycle: `getOrCreateNovaSTTConnection()`, `connectToNovaSTT()`, `closeNovaSTTConnection()`, `restartNovaSTTConnection()`, `handleReconnectNova()`
  - Uses shared `dedupedConnect()` from `src/shared/ws-connection.ts` to prevent concurrent connection attempts
- STT queue + finalization: `enqueueAudioForSTT()`, `ensureSTTDrain()`, `requestFinalize()`, `requestCloseStreamDueToInactivity()`, `processAudioForSTT()`
- Alarms + deadlines: `scheduleSTTReconnect()`, `scheduleInactivityIfIdle()`, `cancelInactivity()`, `scheduleKeepAliveIfPreForwarding()`, `cancelKeepAlive()`, `alarm()` (alarm rescheduling is handled by `stateStore.rescheduleAlarm()`)
- State management: `stateStore.update()`, `stateStore.deleteKeys()`, `stateStore.save()`, `stateStore.restore()`
- Audio processing: `toMono16kFromStereo48k()` (in `src/shared/audio-utils.ts`), `extractPcmFromSfuPacket()` (in `src/shared/sfu-utils.ts`), SpeexDSP resampler
- Init safety: constructor + `this.ctx.blockConcurrencyWhile(() => stateStore.restore())`
- Hibernation optimization: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`

---

## State Machines

### 1) Client Occupancy (connected Durable-Object WebSockets)

States:
- `None`
- `OnlyTranscription`
- `OnlyAudio` (enforced single SFU audio subscriber)
- `Both`

Events/Transitions:
- Transcription connect → `handleTranscriptionStream()` → cancel inactivity
- SFU audio connect → `handleSFUSubscribe()` → enforces single subscriber (closes any existing sfu-audio sockets with code 1000 "Superseded by newer subscriber"), cancel inactivity
- On any WS close → `webSocketClose()` schedules `cleanupDeadline` for deferred cleanup
  - At alarm time → `getOpenConnectionCounts()` counts only OPEN sockets:
    - If no audio remains → delete `sfuAdapterId`
    - If no clients remain → `closeNovaSTTConnection()` and `scheduleInactivityIfIdle('all-sockets-closed')`

ASCII:
```
                +---------------------+
                |        None         |
                +---------------------+
                 | Transcription open
                 v
        +-----------------------+
        | OnlyTranscription     |
        +-----------------------+
                 ^                  \
                 | WS close          \ SFU open
                 |                    v
        +-----------------------+   +----------------+
        | OnlyAudio             |<--|      Both      |
        +-----------------------+   +----------------+
                 ^                    /  Any WS close
                 | Transcription open /
                 +--------------------+
                 On last WS close:
                 - closeNovaSTTConnection()
                 - scheduleInactivityIfIdle('all-sockets-closed')
```

---

### 2) Forwarding Adapter Lifecycle

States:
- `NotForwarding` (no `sfuAdapterId`)
- `ForwardingActive` (has `sfuAdapterId`)

Events/Transitions:
- Start: `handleStartForwarding()` → creates adapter, stores `sfuAdapterId`, sets `allowReconnect = true`, cancels inactivity and KeepAlive
- Stop: `handleStopForwarding()` → close adapter via SFU API, delete `sfuAdapterId`, `requestFinalize()`, re-enter pre-forwarding (ensure Nova open + resume KeepAlive); if no clients remain → `scheduleInactivityIfIdle('stop-forwarding')`

ASCII:
```
+-------------------+   POST /start-forwarding   +--------------------+
|   NotForwarding   | -------------------------> |  ForwardingActive  |
+-------------------+                            +--------------------+
       ^                                                  |
       |           POST /stop-forwarding                  |
       +--------------------------------------------------+
Actions on stop:
- close adapter via SFU API
- delete sfuAdapterId
- requestFinalize() to flush transcriptions (keeps Nova open)
- ensure Nova connection and resume KeepAlive (re-enter pre-forwarding)
- if nobody here: scheduleInactivityIfIdle('stop-forwarding')
```

---

### 3) Nova STT WebSocket Lifecycle (pre-warm + reconnect gating)

States:
- `Disconnected`
- `Connecting`
- `Connected`

Events/Transitions:
- Pre-warm on mic publish: `handleSTTConnect()` sets `allowReconnect=false`, then `getOrCreateNovaSTTConnection()`, `scheduleKeepAliveIfPreForwarding()`; if still idle → `scheduleInactivityIfIdle('prewarm-nova')`
- Demand-connect when draining queue: `ensureSTTDrain()` → `getOrCreateNovaSTTConnection()`
- Debug restart: `handleReconnectNova()`
  - If no clients: `closeNovaSTTConnection()` + short inactivity grace (debug) and return
  - Else: `allowReconnect=true`, `restartNovaSTTConnection()`, cancel inactivity
- On WS `'close'`: if `allowReconnect` and attempts < max → `scheduleSTTReconnect()`
- On last client close: `closeNovaSTTConnection()` immediately
 - Alarm reconnect failure: if a reconnect attempt inside `alarm()` fails before a WS `'close'` event, `alarm()` calls `scheduleSTTReconnect()` to continue exponential backoff until `maxReconnectAttempts`

ASCII:
```
+--------------+   getOrCreateNovaSTTConnection    +------------+
| Disconnected | --------------------------------> | Connecting |
+--------------+                                   +------------+
       ^                                                 |
       |   close / error                                 | on open
       |                                                 v
       |                                           +------------+
       +-------------------------------------------| Connected  |
                                                   +------------+
On WS close:
- if allowReconnect and attempts < max: scheduleSTTReconnect()
- else remain Disconnected

Pre-warm (POST /connect):
- allowReconnect = false
- connect Nova STT
- scheduleKeepAliveIfPreForwarding() to prevent Nova timeout
- if idle, schedule inactivity

Debug restart (POST /reconnect-nova):
- if no clients: close + short inactivity
- else: allowReconnect = true, restart Nova, cancel inactivity
```

---

### 4) STT Send FIFO Queue + Finalization

States:
- `Idle`
- `Draining`
- `PendingFinalize` (send `{type:'Finalize'}` when drained - keeps Nova open)
- `PendingClose` (send `{type:'CloseStream'}` when drained - closes Nova)

Events/Transitions:
- Enqueue audio: `enqueueAudioForSTT()` (called by `processAudioForSTT()` after resample)
- Drain loop: `ensureSTTDrain()` coalesces and sends batches
  - When `pendingFinalize && queued==0`: sends `{type:'Finalize'}` to flush transcriptions (Nova stays open)
  - When `pendingClose && queued==0`: sends `{type:'CloseStream'}` for inactivity cleanup (Nova will close)
- Stop-forwarding: `requestFinalize()` sets `pendingFinalize=true` and triggers drain
- Inactivity: `requestCloseStreamDueToInactivity()` sets `pendingClose=true` and `closingDueToInactivity=true`, triggers drain

ASCII:
```
      enqueue (audio)
 +---------+ --------------> +----------+
 |  Idle  |                 | Draining |
 +---------+ <-------------- +----------+
      ^           drain done & no queued
      |           and no pending control messages
      |
      | requestFinalize() (stop-forwarding):
      | pendingFinalize = true
      | → ensureSTTDrain() → sends {type:'Finalize'}
      | → Nova stays open
      |
      | requestCloseStreamDueToInactivity():
      | pendingClose = true, closingDueToInactivity = true
      | → ensureSTTDrain() → sends {type:'CloseStream'}
      | → Nova will close → broadcast stt_done
```

---

### 5) Unified Alarms (Reconnect + Inactivity + KeepAlive + Cleanup)

States:
- `AlarmOff` (no deadlines)
- `AlarmOn` (earliest of inactivity, reconnect, keepAlive, or cleanup deadlines)

Events/Transitions:
- Set cleanup: `webSocketClose()` → write `cleanupDeadline` (now + 100ms) → `rescheduleAlarm()`
- Set inactivity: `scheduleInactivityIfIdle()` → write `inactivityDeadline` → `rescheduleAlarm()`
- Cancel inactivity: `cancelInactivity()` → delete deadline → `rescheduleAlarm()`
- Set reconnect: `scheduleSTTReconnect()` → write `reconnectDeadline` → `rescheduleAlarm()`
- Set KeepAlive: `scheduleKeepAliveIfPreForwarding()` → write `keepAliveDeadline` (every 5s) → `rescheduleAlarm()`
- Cancel KeepAlive: `cancelKeepAlive()` → delete deadline → `rescheduleAlarm()`
- Alarm fires: `alarm()`
  - If cleanup due: count only OPEN sockets via `getOpenConnectionCounts()`, clear `sfuAdapterId` if no audio, close Nova + schedule inactivity if no clients, clear deadline
  - If KeepAlive due and gating conditions met (Nova open, `sfuSessionId` exists, no `sfuAdapterId`): send `{type:'KeepAlive'}`, schedule next
  - If inactivity due and nobody here: `requestCloseStreamDueToInactivity()` → Nova closes → broadcasts `stt_done`, closes transcription clients
  - If reconnect due and allowed: attempt reconnect; on failure `alarm()` schedules the next attempt via `scheduleSTTReconnect()` until `maxReconnectAttempts` (mirrors WS `'close'` path); clear attempts if disabled/exceeded
  - Alarm rescheduling is handled implicitly by `stateStore.update()/deleteKeys()` after any deadline changes

ASCII:
```
+-----------+    set inactivity / reconnect     +-----------+
| AlarmOff  | --------------------------------> | AlarmOn   |
+-----------+                                   +-----------+
     ^                                               |
     | implicit alarm reschedule via stateStore      v
     +-----------------------------------------------+
```
alarm():
- If KeepAlive due and conditions met:
  - send {type:'KeepAlive'} to Nova
  - schedule next KeepAlive (+5s)
- If inactivity due and nobody here:
  - requestCloseStreamDueToInactivity()
  - Nova will close → broadcast stt_done
- If reconnect due and allowed:
  - attempt reconnect or stop if disabled/max attempts
- alarm is implicitly rescheduled via stateStore deadline management

---

### 6) Transcription Broadcast

States:
- `N clients` (0..N) on `/transcription-stream`

Events/Transitions:
- On Nova JSON message → `handleNovaSTTMessage()` → `broadcastTranscriptionResult()` (buffer last ~100)
- On `from_finalize` response → `broadcastSegmentFinalized()` (segment boundary, Nova stays open)
- On Nova close due to inactivity → `broadcastTranscriptionDone()` sends `stt_done`, closes transcription clients
- Late joiners receive buffered transcriptions in `handleTranscriptionStream()`
- Note: `response.created` is NOT used as a completion signal

---

## Endpoint Effects (Summary)

- `POST /<sid>/stt/connect`
  - Publish mic to SFU session (autoDiscover)
  - Store `sfuSessionId`, `micTrackName`, `sfuCallbackUrl`
  - Pre-warm Nova (`allowReconnect=false`), `scheduleKeepAliveIfPreForwarding()`
  - If idle, schedule inactivity
  - **Client must wait for RTCPeerConnection.connectionState === 'connected' before calling /start-forwarding**

- `POST /<sid>/stt/start-forwarding`
  - Create SFU WS adapter -> this DO; store `sfuAdapterId`
  - Enable `allowReconnect = true`, cancel inactivity and KeepAlive
  - Note: Call only after WebRTC connection established to avoid "Track not found on remote peer" error

- `POST /<sid>/stt/stop-forwarding`
  - Close adapter via SFU API; delete `sfuAdapterId`
  - **Idempotent**: If SFU returns 503 with `errorCode: "adapter_not_found"`, treats as success and proceeds with cleanup
  - Call `requestFinalize()` to flush transcriptions (keeps Nova open)
  - Re-enter pre-forwarding: ensure Nova connection and resume KeepAlive for fast re-start
  - If no clients connected, schedule inactivity

- `WS /<sid>/stt/sfu-subscribe`
  - Accept SFU audio; enforce single subscriber (closes any existing sfu-audio sockets with code 1000 "Superseded by newer subscriber"); cancel inactivity; `webSocketMessage()` → `handleSFUAudioPacket()` → process + enqueue

- `WS /<sid>/stt/transcription-stream`
  - Accept client; cancel inactivity; replay buffer; broadcast updates

- `POST /<sid>/stt/reconnect-nova` (debug)
  - If no clients → `closeNovaSTTConnection()` + short inactivity grace
  - Else → set `allowReconnect=true`, `restartNovaSTTConnection()`, cancel inactivity

 - `DELETE /<sid>` (debug, Worker root)
  - Routed by `src/index.ts` (not under `/stt`)
  - Calls both adapters' `destroy()` concurrently
  - STT effects: closes Nova STT WS, closes all DO WebSocket clients (sfu-audio and transcription-stream), clears queues/buffers, cancels alarms, wipes all persisted state
  - Security: unauthenticated in this demo; add auth in production

---

## Notes

### Concurrency and State Management
- `this.ctx.blockConcurrencyWhile()` in the constructor guards `stateStore.restore()` to avoid init races
- State management uses `stateStore.update()` and `stateStore.deleteKeys()` helpers for batched updates
- Single `stateStore.save()` persists to storage key `'sttState'`
- Unified alarm scheduling uses persisted deadlines (`inactivityDeadline`, `reconnectDeadline`, `keepAliveDeadline`)
- DO alarm is set to earliest deadline; all are safely resumed after hibernation/restarts

### WebSocket Hibernation Optimization
- `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` prevents wake-ups from ping/pong
- WebSocket sessions use `serializeAttachment()` for hibernation-safe state

### Endpoint Methods
- The implementation routes endpoints based on path; HTTP method enforcement for `/start-forwarding` and `/stop-forwarding` is not strict. Clients should still use `POST` as documented.

### Audio Processing
- Input: PCM stereo 48kHz from SFU packets via `extractPcmFromSfuPacket()`
- Conversion + resample: `toMono16kFromStereo48k()` performs stereo→mono and 48k→16k
- Resampling preference:
  1. SpeexDSP WASM: `SpeexResampler.tryCreate(1, 48000, 16000)` and `.processInterleavedInt()`
  2. JS fallback: internal downsampler used when Speex unavailable
- Safety: Even-byte enforcement handled in helpers for 16-bit PCM alignment
- Output: PCM mono 16kHz to Nova STT

### Control Message Semantics
- **Finalize**: Used for stop-forwarding to flush transcriptions while keeping Nova open
- **CloseStream**: Reserved for inactivity cleanup; triggers Nova close and client disconnection
  - **Inactivity guard**: When Nova closes with `closingDueToInactivity=true`, the DO re-checks occupancy before disconnecting clients (prevents closing newly-joined clients if CloseStream send had failed earlier)
- **KeepAlive**: Sent every 5s during pre-forwarding window (prevents Nova timeout)

### Timing Considerations
- Pre-warm reduces time-to-first-transcription after mic publish
- KeepAlive prevents Nova timeout during pre-forwarding window
- Client must wait for `RTCPeerConnection.connectionState === 'connected'` before calling `/start-forwarding`
  (avoids "Track not found on remote peer" error when using autoDiscover)
