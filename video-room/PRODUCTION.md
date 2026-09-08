# Production integration

This blueprint is experimental. Treat it as a transparent starting point, not
as a claim that one deployment policy fits every application.

## Authentication

`src/server/auth.ts` is the replaceable application-authentication seam.

Deployed requests use `AUTH_MODE=cloudflare-access`. The Worker verifies the
`Cf-Access-Jwt-Assertion` signature, issuer, and application audience against
the configured Access team. The resulting JWT subject is the application
principal. Put the Worker route behind the matching Access application before
inviting users.

The checked-in Wrangler default is `cloudflare-access`; a missing mode is an
error rather than an implicit development fallback. `npm run dev` explicitly
sets `AUTH_MODE=local` plus an explicit browser identity. The code accepts that
mode only for `localhost`, `127.0.0.1`, or `[::1]`; a deployed host in local
mode returns `local_auth_unavailable`.

To integrate another identity provider, replace `authenticateRequest` while
preserving its `{subject, displayHint}` output and the rule that the browser
cannot assert a trusted subject by itself.

## Authorization

Authentication and room authorization are separate:

| Operation | Policy |
| --- | --- |
| Join | Any authenticated application principal may create/join a valid room name. |
| Snapshot and heartbeat | The principal must present its random room member token. |
| Notification ticket | The principal and member token must match an active participant; the returned ticket expires after 30 seconds and is single-use. |
| Notification socket | The browser offers the fixed protocol plus a `ticket.<value>` `Sec-WebSocket-Protocol` token; the upgrade consumes the ticket and selects only the fixed protocol. No member token or ticket is accepted from the URL. |
| Publish | The token may mutate only its participant's producer SFU session. |
| Subscribe | The token may mutate only its participant's consumer SFU session, and track keys are resolved against current Durable Object state. |
| Leave and reconnect | The token and application principal must match the membership and browser client ID. |
| Terminate | The token must belong to the immutable room creator. |

Only a SHA-256 member-token hash is stored. Do not replace the token check with
room names, participant IDs, track names, SFU session IDs, or URLs.
The browser-generated capability, reconnect request ID, and explicit media
generation make identical lifecycle retries idempotent and fence late SDP
mutations from replacement sessions.

## Credentials

Configure these server-side bindings:

- `REALTIME_SFU_APP_ID`: the Realtime SFU application identifier.
- `REALTIME_SFU_BEARER_TOKEN`: a Wrangler secret used only by server code.
- `CF_ACCESS_TEAM_DOMAIN`: the Access team domain.
- `CF_ACCESS_AUD`: the Access application audience.

Do not expose them as public environment variables, HTML substitutions, query
parameters, browser logs, error bodies, source maps, or screenshots. The build
emits no source maps and `npm run scan:browser` checks generated assets.
Local Vite development loads the two SFU values from ignored `.dev.vars` with
file mode `0600`; do not pass the bearer token through `--var`.

## Origin and input controls

The application is same-origin. Cross-site mutation requests are rejected from
`Origin` and Fetch Metadata headers. Room names, display names, client IDs,
mutation IDs, track keys, mids, JSON shapes, and SDP size are bounded.

Before broad public access, add controls appropriate to the product:

- Per-principal join and reconnect rate limits.
- Active-room, participant, and media-track quotas.
- Request/body limits at the edge.
- Abuse reporting and room-creator recovery policy.
- A maximum room size aligned with measured browser and application behavior.
- Per-participant ticket issuance and concurrent notification-socket limits.

Do not make the direct room URL the access policy.

## State and concurrency

One Durable Object is the application source of truth for each room. Keep all
mutations for a given SFU session behind `SessionMutationQueue`. In particular,
do not unlock or start another track operation after receiving an immediate SFU
offer; wait until the browser answer succeeds through `/renegotiate`.

Keep the browser-facing API on authenticated HTTP and use typed Durable Object
RPC behind the Worker for ordinary room operations. Return expected application
outcomes as serializable tagged unions and map them to HTTP in the Worker.
Reserve thrown RPC exceptions for unexpected infrastructure or invariant
failures. Do not retry them transparently or reuse the failed stub; obtain a
fresh named stub for a later request. Keep `fetch()` only for the WebSocket
upgrade.

Cleanup must seal or invalidate the relevant session queues and wait for active
SFU work before closing mids. Do not mark presence left while an unfenced media
mutation can still commit. Client media generations and participant lifecycle
versions are both required defenses.

The current implementation uses a hibernating WebSocket only to announce room
revision changes. Browsers then fetch the authorized HTTP snapshot and perform
the existing HTTP subscription flow. A periodic 15-second HTTP poll provides an
independent convergence check. Do not add SDP, track locators, credentials, or
mutation commands to the socket.

Sockets are accepted with `acceptWebSocket()`, discovered for broadcast with
`getWebSockets()`, and carry only a bounded participant ID attachment. Do not
replace this with an in-memory registry that disappears during hibernation.
Opening a newer socket closes the participant's prior notification socket.

## Cleanup and retention

Tune `ROOM_STALE_SECONDS` between 20 and 300 seconds. The default is 45.
Heartbeats are ten seconds. Explicit leave/terminate closes known mids
immediately; abandoned clients are force-cleaned by the Durable Object alarm.
Forced cleanup attempts producer and consumer sessions concurrently but does
not remove presence when either close fails. Partial success is safe to retry
because already-closed items are accepted. Membership tombstones remain for
five minutes to make repeated cleanup safe, then empty room storage is deleted.

The close endpoint can return per-track errors under HTTP 200, and those items
do not carry their own HTTP status. Only the externally returned
already-absent item result is treated as converged. Every other per-track error
preserves state for retry. An actual HTTP 404 or 410 from the close request is
also treated as already absent.

Alarm cleanup failures schedule another alarm at least five seconds later.
Terminated peers retain bounded snapshot authorization through their tombstone
so they can observe terminal state and clean up locally.

Notification socket close is not a leave signal. Browser/network socket
lifecycle is independent from presence; heartbeat expiry remains authoritative.

Every Realtime SFU HTTP request has a ten-second timeout. Keep retry budgets
bounded above that timeout rather than allowing an external request to hold a
Durable Object operation indefinitely.

Classify SFU transport failures from the actual HTTP response: network errors,
timeouts, HTTP 429, and HTTP 5xx may be retried, while ordinary HTTP 4xx should
not be. Do not infer a status from `errorCode` or `errorDescription`. Errors
embedded in HTTP 200 responses become bounded generic upstream failures, and
raw provider descriptions must not enter application responses.

If application policy requires audit history, write bounded audit events to a
separate system. Do not retain bearer tokens, raw Access JWTs, SDP, or customer
media in logs.

## Observability

Responses include an `x-request-id` and stable application error code. Log
request IDs, room-safe hashes if needed, operation names, queue timeouts, and
SFU error codes. Do not log request headers, member tokens, Access JWTs, SFU
authorization headers, SDP, or full SFU response bodies.

Ticket issuance, ticket rejection, active hibernating socket count, reconnect
attempts, and safety-poll use are useful notification-path signals. Never log
the ticket, subprotocol header, member token, or serialized attachment.

Useful browser measurements include PeerConnection state transitions,
selected candidate pair, inbound/outbound bitrate, packets lost, frames
decoded, and freeze count from `getStats()`. This blueprint displays connection
status but does not export metrics.

## Release review

Before treating an adaptation as maintained:

- Run a clean install, unit and Workerd integration tests, typecheck, build, and
  browser asset scan.
- Regenerate `worker-configuration.d.ts` with `npm run cf-typegen` after changing
  Worker bindings or exported entrypoint classes.
- Validate two fresh tabs in one Chrome profile against a non-production SFU
  application. Validate Access authentication manually; do not use the local
  Playwright test as Access evidence. Use separate profiles only for distinct
  Access identities.
- Exercise refresh, temporary disconnect, explicit leave, repeated cleanup,
  creator termination, and stale expiry.
- Review Access policy, origin routing, rate limits, quotas, retention, alerts,
  and incident cleanup for the application.
- Confirm generated assets and runtime logs contain no credentials.
