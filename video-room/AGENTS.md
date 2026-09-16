# Video room agent instructions

## Goal

Keep this a complete but small Realtime SFU room: multiple browser
participants, one Durable Object per room, and explicit authentication,
authorization, reconnect, and cleanup. Do not turn it into a conferencing
framework.

Use [ARCHITECTURE.md](ARCHITECTURE.md) for the flow and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for symptoms. The invariants below must
survive adaptations.

## Code map

- React presentation: `src/client/App.tsx`; page startup: `main.tsx`.
- Browser behavior: `src/client/room-controller.ts`, `media.ts`, `lifecycle.ts`,
  `notifications.ts`, and `background.ts`.
- HTTP and authentication boundary: Hono routes in `src/worker.ts`,
  `src/server/auth.ts`, and response formatting in `src/server/http.ts`.
- Room state and lifecycle: `src/server/room.ts`, `room-media.ts`,
  `room-state.ts`, and `video-room.ts`.
- Negotiation ownership: `lifecycle-queue.ts` and
  `session-mutation-queue.ts`.
- Realtime SFU access: `src/server/realtime.ts`.
- Browser/Worker contract: Zod schemas and inferred types in
  `src/shared/protocol.ts`; HTTP response validation in `src/client/api.ts`.
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
- Preserve the SFU client's timeout while awaiting response headers.

## Room lifecycle

- React subscribes to the room controller's view snapshots. Keep room actions,
  media ownership and page resume outside component effects. A video component
  detaches its stream on unmount; the controller decides when tracks stop.
- One named Durable Object owns membership, creator authority, publication
  discovery, revisions, session state, stale cleanup, and room termination.
- Browser and participant lifecycle operations remain serialized and
  idempotent. Explicit Leave cannot be undone by a delayed reconnect.
- Save schema-validated join/reconnect membership inside the current lifecycle
  transition before starting media setup. A failed publish or subscribe must
  retain that membership for recovery. Promote the room UI only after media
  setup succeeds.
- Reconnect reuses the participant identity while replacing both SFU sessions.
- Seal or invalidate session queues before cleanup, drain active work, retain
  returned mids, and close known resources before changing presence.
- Leave, termination, stale expiry, and repeated cleanup must converge safely.
  If forced cleanup fails, keep presence and schedule another alarm attempt.
- During Leave or Terminate, close PeerConnections for teardown but retain
  membership and local capture until the server confirms cleanup.
- Cleanup may accept an actual HTTP 404 or 410 and the public already-absent
  item result. Other per-track errors retain state for retry.
- Terminated tombstones remain authorized only for the bounded terminal
  snapshot window.

## Durable Objects and notifications

- Validate external JSON once in the Worker, after authentication and the body
  size check. Resolve principal-dependent defaults there. The Durable Object
  receives typed commands and retains stateful authorization and lifecycle
  checks, including checks after asynchronous work.
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
- Keep the `Cf-Ray`/`x-request-id` diagnostic ID separate from retry-stable
  reconnect request IDs and media mutation IDs. Validate browser HTTP responses
  before replacing membership; malformed successful responses must not trigger
  automatic mutation retries.

## Scope

- Do not add PartyTracks, PartyKit, a conferencing abstraction, or direct
  authenticated SFU calls from the browser.
- Do not add chat, recording, screen sharing, end-to-end encryption, AI,
  moderation, or advanced layouts.
- Treat public tests, fixtures, comments, metadata, and generated assets as
  documentation. Assert only public SFU behavior and application-owned
  invariants.

## Verification

Run the declared checks for implementation changes:

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

`npm run check` covers types, mocked SFU behavior, build, and credential scans.
With the dev server running, opt into real SFU media and recovery validation:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

When changing authentication, add allowed and denied tests. When changing media
or lifecycle behavior, retain focused concurrency, reconnect, repeated cleanup,
and stale-expiry coverage. Prefer an existing scenario or a focused regression
over tests that repeat library behavior. Documentation-only changes use the
repository foundation checks; rerun media validation when behavior changes.
