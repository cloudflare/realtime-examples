# Architecture

![Video room architecture](architecture.svg)

The editable diagram source is [architecture.mmd](architecture.mmd). Regenerate
it with `npm run diagram`.

Each room has one Durable Object. Media flows between browsers and Realtime
SFU; the application backend coordinates membership and the tracks to receive.

| Component | Responsibility |
| --- | --- |
| Browser | Capture and receive media, apply SDP, and present room state |
| Worker | Authenticate HTTP requests, validate input, and call typed room operations |
| Durable Object | Authorize operations and own membership, discovery, session state, and cleanup |
| Realtime SFU | Receive published tracks and forward requested tracks |

## Trust boundaries

Cloudflare Access JWT verification supplies the deployed application identity.
Local development uses an explicit identity that is accepted only on loopback
hosts. Room names, participant IDs, SFU session IDs, track names, and mids are
locators; authorization also requires the application principal and membership
capability. SFU credentials remain in the Durable Object's server-side client.

The browser creates a random member capability before joining and sends it in
the initial JSON body. Later requests use `x-room-member-token`. The Durable
Object stores only its SHA-256 hash; the browser keeps the capability in
per-tab `sessionStorage`.

Hono routes requests in the Worker, which authenticates the caller, bounds and
decodes the body, resolves principal-dependent defaults, and validates with
Zod. [Shared schemas](src/shared/protocol.ts) define request and response types.
The Durable Object receives typed commands and checks membership, creator
rights, room state, and current sessions, including after queued work and
external calls. Valid request shape does not grant authorization.

Ordinary Worker-to-Durable Object calls use RPC. Expected application failures
return `{ type: "error", error }`; success returns `{ type: "ok", value }`.
The Worker maps these to HTTP responses. Unexpected runtime or invariant
failures remain thrown exceptions; a later request obtains a fresh stub.
Only the notification WebSocket upgrade uses the stub's `fetch()` method.
The browser validates HTTP responses before using them; malformed responses
produce bounded errors without automatic retries.

## Media direction

Each participant owns two independent browser/SFU session pairs:

- The producer PeerConnection publishes local audio and video.
- The consumer PeerConnection receives the other participants' tracks.

The **media generation** identifies the current session pair. The Durable
Object increments it when replacing both sessions; browser media requests must
include the returned generation.

A single bidirectional PeerConnection is also valid when publish and subscribe
share one serialized offer/answer lifecycle. This example uses separate
sessions so each direction has its own negotiation queue.

## Signaling and state flow

1. After acquiring local media, the browser joins the room. The Durable Object
   creates membership plus producer and consumer SFU sessions. The browser
   validates the response and saves confirmed membership immediately.
2. The browser creates a producer offer and sends it through `/publish`. The
   backend calls SFU `tracks/new`, stores successful publications in discovery
   state, and returns the answer for the browser to apply.
3. The browser sends its desired remote track keys through `/subscribe`. The
   backend resolves them to publisher session IDs and track names and calls
   `tracks/new` on the consumer session. If the response requires immediate
   renegotiation, the browser applies the offer, creates an answer, and sends
   it through `/renegotiate`.
4. Once publishing and initial subscription setup succeed, the browser shows
   the connected room. The first participant can have an empty subscription
   set. Later snapshots feed new discovery updates into the consumer queue.

Membership confirmation precedes media readiness. A later publish or subscribe
failure leaves confirmed membership available for [recovery](#reconnect).
The browser must not create another membership merely because media setup
failed.

## Notification WebSocket

The socket announces revisions with this payload:

```json
{"type":"room-changed","revision":12}
```

On socket open or a revision message, the browser fetches an authorized HTTP
snapshot. A 15-second safety poll covers missed notifications. SDP, media
locators, and mutations stay on HTTP.

An authenticated `/socket-ticket` request issues a 30-second, single-use ticket.
The browser sends it through `Sec-WebSocket-Protocol`, never a URL. The Durable
Object consumes its stored hash and expiry, and a newer socket replaces the
participant's previous one. Reconnection uses bounded backoff and a fresh
ticket for each attempt.

Sockets use `acceptWebSocket()` and bounded `{participantId}` attachments via
`serializeAttachment()`. Broadcast and targeted closure restore attachments
with `deserializeAttachment()` and find sockets through `getWebSockets()`, so
the connection list survives hibernation. Socket close or error does not remove
presence; [heartbeat expiry and cleanup](#cleanup) own that decision.

## SDP serialization

Every SFU session has a FIFO mutation queue. A response containing an immediate
SFU offer keeps that queue locked until the matching browser answer succeeds
through `/renegotiate`. Later track mutations and normal Leave wait behind
that exchange. [Forced cleanup](#cleanup) invalidates the pending exchange and
drains active SFU calls.

The browser also serializes operations per PeerConnection. A subscription owns
the full cycle from applying the remote offer through applying its local answer
and receiving renegotiation acknowledgment. Retrying the same operation reuses
its mutation ID and prepared SDP; work arriving while signaling is unstable
remains queued.

Every media request must match the current generation. Checks after external
calls also prevent an old session's completion from changing replacement state.
If an answer is missing for 15 seconds, the session becomes invalid and queued
work receives a reconnect-required error.

The SFU client waits up to ten seconds for response headers; reading the body
is outside that timeout. It classifies network failures, timeouts, HTTP 429,
and HTTP 5xx as retryable. An error embedded in a successful HTTP response
becomes a generic retryable upstream failure. Actual HTTP status determines
retryability; provider descriptions are not returned to the browser. Resource
handling for partial results is described in
[Cleanup](#cleanup).

## Identifier ownership

- The application URL selects the room name.
- The browser creates its tab's client ID, member capability, reconnect request
  IDs, mutation IDs, and SDP.
- The Durable Object creates participant IDs, media generations, track names,
  creator authority, and room revisions, and stores capability hashes.
- Realtime SFU returns session IDs and assigns or confirms transceiver mids.

`x-request-id` uses `Cf-Ray` when available and a UUID locally. It correlates one
HTTP request with diagnostics. The reconnect body's `requestId` and media
`mutationId` identify logical operations and stay stable across their retries.

## Reconnect

The tab retains its client ID, member token, display name, and joined intent in
`sessionStorage`. Refresh or connection failure calls `/reconnect`. The Durable
Object authorizes the same membership, closes known mids, replaces both SFU
sessions, and returns the same participant ID with a new media generation. The
browser then republishes and rebuilds its remote subscriptions.

If initial media setup fails after membership was confirmed, retrying Join or
refreshing uses that saved membership to replace the sessions. If the backend
reports that membership is no longer valid, the browser falls back to joining.

The setup loop makes at most three attempts for errors marked retryable. Within
that loop, an unconfirmed join reuses its pending capability, and an
unconfirmed reconnect reuses its request ID. Once a replacement is confirmed,
a later media failure requires a new reconnect operation and request ID. This
separates retrying a request from replacing a session pair.

One lifecycle transition owns the browser's current room state. Reconnect
pauses background polling and heartbeats while replacing media; a later Leave
or Terminate supersedes it. Delayed completions cannot restore a departed room.

React renders snapshots from `room-controller.ts` and invokes its actions.
Page startup resumes saved membership once, outside component effects. Video
components attach or detach streams; the controller owns when tracks stop.

## Cleanup

Leave appends cleanup to each session queue and seals it against later
mutations. Forced cleanup for reconnect, termination, or expiry invalidates
new work and drains active SFU calls before closing known mids. Membership is
marked left only after cleanup succeeds.

The backend retains usable requested/returned mids before rejecting a partial
or malformed SFU track response. Track closure accepts an actual HTTP 404 or
410 and the public already-absent item result; other errors retain the mid set
for another cleanup attempt. Empty room storage is deleted after cleanup and
tombstone expiry.

The browser closes its PeerConnections during Leave or Terminate, but keeps
membership, local capture, and room UI until the server confirms cleanup.
Failure leaves that state available to retry; success stops capture and returns
to the lobby.

The first successful participant remains the room creator even after leaving
or expiring. Only that membership can terminate the room. Other participants
retain authorized access to the terminal snapshot during the five-minute
tombstone window, so they can observe termination and clear local state.

Heartbeats run every ten seconds. Inactive participants become eligible for
alarm cleanup after 45 seconds by default. Failed closes keep presence and
schedule another alarm at least five seconds later. Successful departure
closes the participant's notification sockets.

## Failure modes

The status message reports the failure and request ID when available; API
error responses also include an application code. Inspect the first failed
operation: a later lifecycle error can follow an earlier setup failure. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for recovery and diagnostic steps.

## Capability status

This experimental example implements multi-participant audio/video, room
membership and discovery, reconnect, creator termination, and cleanup. See the
[README limitations](README.md#known-limitations) for omitted features and
[PRODUCTION.md](PRODUCTION.md) for deployment policies and controls.
