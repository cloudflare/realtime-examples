# Video room agent instructions

## Goal

Keep this a complete but small Realtime SFU room: multiple browser
participants, one Durable Object per room, and explicit authentication,
authorization, reconnect, and cleanup. Do not turn it into a conferencing
framework.

## Code map

- Browser behavior: `src/client/`, especially `media.ts`, `lifecycle.ts`,
  `notifications.ts`, and `safety-poller.ts`.
- HTTP and authentication boundary: `src/worker.ts` and `src/server/auth.ts`.
- Room state and lifecycle: `src/server/room.ts`, `room-media.ts`,
  `room-state.ts`, and `video-room.ts`.
- Negotiation ownership: `lifecycle-queue.ts` and
  `session-mutation-queue.ts`.
- Realtime SFU access: `src/server/realtime.ts`.
- Browser/Worker contract: `src/shared/protocol.ts`.
- Runtime integration tests: `tests/workerd/`.

## Security

- Keep Realtime SFU credentials in trusted Worker code. Never expose them in
  browser source, generated assets, responses, URLs, logs, or screenshots.
- Authenticate first, then authorize every snapshot, publish, subscribe,
  reconnect, leave, termination, and notification-ticket request.
- Room, participant, session, track, mid, and URL identifiers are not
  authorization.
- The initial join carries the browser-generated member capability in its JSON
  body. Later requests use the `x-room-member-token` header. Store only its
  hash.
- Never put a member capability or notification ticket in a URL.
- Preserve same-origin mutation checks, creator-only termination, and stale
  cleanup alarms.
- Local identity must fail closed outside loopback hosts. Missing deployed
  authentication configuration must also fail closed.

## Realtime SFU

- Each participant uses separate producer and consumer SFU sessions and
  PeerConnections so each media direction has an independent SDP lifecycle.
- A single bidirectional session is valid only when publish and subscribe
  mutations share one serialized offer/answer queue.
- Serialize every track mutation per SFU session. When the SFU returns an
  immediate offer, keep the queue locked until the browser answer succeeds
  through `/renegotiate`.
- Retain FIFO work while signaling is unstable. Retry with the same mutation ID
  and SDP phase rather than dropping or recreating the mutation.
- Require the current media generation for publish, subscribe, and
  renegotiation. Never apply old SDP to replacement sessions.
- Inspect every per-track result even when the SFU request returns HTTP `200`.
  Use the actual HTTP status for retry decisions.
- Parse only the public `errorCode` and `errorDescription` fields, and never
  return provider descriptions to the browser.
- Keep every direct SFU request bounded by a timeout.

## Room lifecycle

- One named Durable Object owns membership, creator authority, publication
  discovery, revisions, session state, stale cleanup, and room termination.
- Browser and participant lifecycle operations remain serialized and
  idempotent. Explicit Leave cannot be undone by a delayed reconnect.
- Reconnect reuses the participant identity while replacing both SFU sessions.
- Seal or invalidate session queues before cleanup, drain active work, retain
  returned mids, and close known resources before changing presence.
- Leave, termination, stale expiry, and repeated cleanup must converge safely.
  If forced cleanup fails, keep presence and schedule another alarm attempt.
- Clear browser membership and media only after Leave or Terminate is confirmed.
- Cleanup may accept an actual HTTP 404 or 410 and the public already-absent
  item result. Other per-track errors retain state for retry.
- Terminated tombstones remain authorized only for the bounded terminal
  snapshot window.

## Durable Objects and notifications

- Browser-facing APIs stay on HTTP. Ordinary room operations use typed Durable
  Object RPC and serializable tagged unions for expected outcomes.
- Reserve thrown RPC exceptions for unexpected runtime or invariant failures.
  A later request obtains a fresh stub.
- Keep `VideoRoom.fetch()` limited to the WebSocket upgrade.
- Use hibernating sockets with bounded participant attachments and
  `getWebSockets()`. Do not add an in-memory socket registry.
- Issue short-lived, single-use notification tickets over authenticated HTTP
  and send them through `Sec-WebSocket-Protocol`.
- Socket payloads contain only `room-changed` and a revision. Socket close is
  not a leave signal; heartbeat expiry remains authoritative.

## Scope

- Do not add PartyTracks, PartyKit, a conferencing abstraction, or direct
  authenticated SFU calls from the browser.
- Do not add chat, recording, screen sharing, end-to-end encryption, AI,
  moderation, or advanced layouts.
- Treat public tests, fixtures, comments, metadata, and generated assets as
  documentation. Assert only public SFU behavior and application-owned
  invariants.

## Verification

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

Live media validation is opt-in:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

When changing authentication, add allowed and denied tests. When changing media
or lifecycle behavior, retain focused concurrency, reconnect, repeated cleanup,
and stale-expiry coverage.
