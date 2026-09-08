# Video room agent instructions

These instructions apply to this blueprint.

## Authoritative files

- `src/server/room.ts`: membership, authorization, presence, creator authority,
  reconnect, and room lifecycle.
- `src/server/room-media.ts`: publish, subscribe, renegotiate, per-session
  queues, publication discovery, and media cleanup.
- `src/server/room-state.ts`: persisted room, participant, publication, and
  session state.
- `src/server/video-room.ts`: typed Durable Object RPC, alarm, and hibernating
  WebSocket boundary.
- `src/server/lifecycle-queue.ts`: room and participant lifecycle ownership.
- `src/server/session-mutation-queue.ts`: per-SFU-session SDP serialization.
- `src/server/auth.ts`: replaceable application authentication seam.
- `src/server/notifications.ts`: ticket subprotocol, bounded hibernation
  attachments, and revision-only broadcast.
- `src/server/realtime.ts`: the only direct Realtime SFU HTTP client.
- `src/client/media.ts`: separate producer/consumer PeerConnections and full
  browser offer/answer cycles.
- `src/client/lifecycle.ts`: browser join, reconnect, leave, and termination
  ownership.
- `src/client/notifications.ts` and `src/client/safety-poller.ts`:
  notification reconnect/backoff and periodic HTTP safety polling.
- `src/shared/protocol.ts`: browser/server contract.
- `vite.config.ts`: Vite development and Cloudflare Worker build boundary.
- `tests/workerd/`: Worker routing, Durable Object storage, alarms, eviction,
  and hibernating WebSocket integration tests.
- `ARCHITECTURE.md` and `PRODUCTION.md`: lifecycle and trust boundaries.

## Invariants

- Keep SFU application credentials in trusted Worker code. They must not enter
  browser source, generated assets, responses, URLs, logs, or screenshots.
- This implementation keeps separate producer and consumer SFU sessions and
  PeerConnections to make each direction easy to inspect. A single
  bidirectional session is valid only when all publish and subscribe mutations
  share one serialized offer/answer lifecycle.
- Use the Cloudflare Realtime documentation and OpenAPI schema as the product
  contract. Do not make an adaptation depend on behavior those sources do not
  define.
- Treat tests, fixtures, comments, metadata, screenshots, and commit messages
  as part of the example. Assert observable API behavior and this application's
  own invariants.
- Parse only the public SFU `errorCode` and `errorDescription` fields. Use the
  actual HTTP status for retry decisions and never return provider descriptions
  to the browser.
- Serialize every SDP-mutating operation per SFU session.
- An immediate SFU offer owns the queue until its browser answer succeeds via
  `/renegotiate`.
- Retain FIFO mutations while signaling is unstable. Retry with the same
  mutation ID and SDP phase; do not silently drop or recreate work.
- Require the current media generation on every publish, subscribe, and
  renegotiate request. Never apply old-generation SDP to replacement sessions.
- Serialize client/participant lifecycle operations. Identical join capability
  and reconnect request IDs must be idempotent.
- Authenticate first, then authorize every snapshot, publish, subscribe,
  reconnect, leave, and termination operation with the member capability.
- Room, participant, session, track, mid, and URL identifiers are not
  authorization.
- Local identity must continue to fail closed on non-local hosts.
- Missing authentication configuration must fail closed. Keep the checked-in
  Wrangler default on `cloudflare-access`; only `npm run dev` opts into local.
- Reconnect reuses presence identity while replacing both SFU sessions.
- Leave, termination, stale expiry, and repeated cleanup stay idempotent.
- Do not clear browser membership/media state until leave or termination is
  confirmed by the server.
- Forced cleanup must attempt both SFU sessions and retain active presence if
  either close fails so a later retry can converge.
- Cleanup must seal or invalidate session queues, drain active work, record any
  returned mids, and only then close tracks or mark presence left.
- Terminated tombstones must remain authorized for bounded terminal snapshots.
- Alarm cleanup failure must schedule another durable alarm attempt.
- Keep every direct SFU HTTP request bounded by a timeout.
- Keep WebSocket notification-only: exactly `room-changed` plus a revision.
- Keep snapshots, SDP, track locators, authorization, and every mutation on
  HTTP.
- Keep browser-facing APIs on HTTP, then map ordinary room operations to typed
  Durable Object RPC methods in the Worker. Expected application outcomes must
  cross RPC as plain tagged unions.
- Reserve thrown RPC exceptions for unexpected runtime or invariant failures.
  Do not reuse a stub after a thrown exception; a later request obtains a fresh
  named stub.
- Keep `VideoRoom.fetch()` limited to the notification WebSocket upgrade.
- Never put a member token or notification ticket in a URL. Issue tickets from
  the authenticated HTTP endpoint and consume them once from the WebSocket
  subprotocol header.
- Use hibernating Durable Object sockets, bounded `{participantId}`
  attachments, and `getWebSockets()` broadcasts. Do not add an in-memory socket
  registry.
- Socket close must never remove presence; heartbeat/stale cleanup is
  authoritative.

## Prohibited shortcuts

- Do not add a conferencing framework or move SFU calls into the browser.
- Do not combine producer and consumer media without also combining their
  mutation serialization and lifecycle ownership for that SFU session.
- Do not resolve the mutation queue when
  `requiresImmediateRenegotiation=true` until the answer is applied.
- Do not trust display names, client IDs, or direct room URLs as principals.
- Do not disable origin checks, stale alarms, token hashing, or creator checks to
  simplify an adaptation.
- Do not turn the notification socket into a second signaling protocol.
- Do not infer HTTP status or retryability from SFU error codes or descriptions.
- Close cleanup may accept an actual HTTP 404 or 410 and the externally returned
  already-absent item result. Every other per-track error must preserve state
  for retry.
- Do not add chat, recording, screen sharing, end-to-end encryption, AI,
  moderation, or advanced layout features to this blueprint.

## Verification

```bash
npm ci
npm run cf-typegen -- --check
npm run test:unit
npm run test:workerd
npm run check
npx wrangler deploy --dry-run
```

The concurrency regression must continue to cover track add, answer, close,
and reconnect ordering. Live media validation is opt-in:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

When adapting authentication, add allowed and denied tests. When changing
media lifecycle, test concurrent mutations, refresh/rejoin, repeated cleanup,
and stale expiry.
