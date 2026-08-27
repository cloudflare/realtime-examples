# Realtime SFU DataChannels

> Example status: **Experimental**

This bounded learning example creates a publisher and subscriber as two separate
browser `RTCPeerConnection` endpoints. They exchange application data through
Cloudflare Realtime SFU without exposing the Realtime SFU bearer token to the
browser.

The primary UI flow teaches one acknowledgment-gated reliable channel:

- A reliable, ordered channel whose remote subscription combines `waitForAck:
  true` and `canReply: true`.
- A compact secondary comparison uses an unordered channel with
  `maxRetransmits: 0` for replaceable state.

It is intentionally not a room, signaling framework, benchmark, or production
application.

## Trust boundary

```text
Browser publisher ──────── DataChannel ───────┐
                                              │
Browser ── same-origin JSON ──> local Node server ── authenticated HTTPS API
                                              │
Browser subscriber <────── DataChannel <──────┘
                              Realtime SFU
```

`REALTIME_SFU_APP_ID` and `REALTIME_SFU_BEARER_TOKEN` are loaded only by
`server.ts`, either from its environment or the ignored local `.dev.vars`
file. The server exposes narrow operations for this example rather than an
arbitrary Realtime SFU proxy. Browser source and server responses contain no
credential values.

The server binds to `127.0.0.1` by default. Do not expose it publicly: it has no
application authentication, authorization, rate limiting, or multi-user state
ownership.

## Run locally

Requirements:

- Node.js 20.12 or newer.
- A Realtime SFU application ID and bearer token.

From this directory:

```bash
npm ci
```

Create `.dev.vars` with one assignment per line:

```dotenv
REALTIME_SFU_APP_ID=<app-id>
REALTIME_SFU_BEARER_TOKEN=<bearer-token>
```

Then start the example:

```bash
npm start
```

The server automatically loads `.dev.vars`. Values already set in the process
environment take precedence, so CI or another launcher can continue to inject
the same variables without using the file. A missing file is allowed when both
variables are already set. Missing values fail closed; malformed or unreadable
files produce an actionable startup error without printing their contents.

`npm start` first bundles `app.ts` and its browser dependencies with esbuild,
then runs the local TypeScript server with `tsx`. The ignored generated file is
`dist/app.js`; the server exposes that bundle as `/app.js` and does not serve
the TypeScript source modules.

Open `http://127.0.0.1:8787`, then:

1. Select **Connect endpoints** and wait for both PeerConnections to report
   `connected` and both application channels to report `open`.
2. Select **Send disposable probe** before acknowledgment. Confirm the
   subscriber log does not receive it while the gate is closed.
3. Select **Send subscriber ACK** within 30 seconds of remote channel creation.
   The SFU consumes this first subscriber message instead of forwarding it.
4. Send a fresh publisher message with the newly enabled post-ACK form and
   confirm that this new message reaches the subscriber.
5. Send the subscriber reply. The publisher receives it on the same reliable
   channel because the subscriber has `canReply`.
6. Optionally send an eight-state burst on the compact unordered,
   zero-retransmission comparison. Receiving every revision or receiving them
   in order is not guaranteed.
7. Select **Teardown** twice. The second attempt reports that cleanup is already
   complete and does not send duplicate close requests.

Delivery is gated before ACK. The SFU may retain only bounded early traffic, so
the disposable probe might be observed after the gate opens. That observation
is not a replay guarantee and the gate is not a durable queue. Send the ACK
before publisher traffic that must be delivered.

Keep credentials only in the ignored `.dev.vars` file or the server process
environment. Do not add them to tracked files, browser storage, URLs,
screenshots, or logs.

## Reliability settings

The same reliability fields are used in three places: the publisher's
`datachannels/new` request, the subscriber's `datachannels/new` request, and
both negotiated browser `createDataChannel()` calls.

| Profile | Local API | Remote API | Browser |
| --- | --- | --- | --- |
| Reliable ordered | `ordered: true` | `ordered: true`, `waitForAck: true`, `canReply: true` | `ordered: true` |
| Replaceable state | `ordered: false`, `maxRetransmits: 0` | `ordered: false`, `maxRetransmits: 0` | `ordered: false`, `maxRetransmits: 0` |

`waitForAck` and `canReply` are remote-only SFU controls, not browser
`RTCDataChannelInit` fields:

- `waitForAck` gates publisher-to-subscriber delivery. The subscriber's first
  message opens the gate, is consumed by the SFU, and must reach the SFU within
  30 seconds after the remote DataChannel is created. The SFU may retain only
  bounded early traffic, but this is not a durable queue or a delivery
  guarantee. Send the ACK before traffic that must be delivered.
- `canReply` lets at most one subscriber send back to the publisher on that
  publisher DataChannel. Later subscriber messages reach only the publisher,
  not other subscribers. Granting reply access to another subscriber replaces
  the previous holder.

The UI renders the exact local API, remote API, and browser configuration for
both profiles.

These semantics were checked on August 27, 2026 against the public
[DataChannels documentation](https://developers.cloudflare.com/realtime/sfu/datachannels/)
and its linked
[OpenAPI schema](https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml).

## API and lifecycle

The browser calls the local server, which validates bounded request bodies and
performs these Realtime SFU operations:

1. `POST /sessions/new`
2. `POST /sessions/{sessionId}/datachannels/establish`
3. `PUT /sessions/{sessionId}/renegotiate`
4. `POST /sessions/{sessionId}/datachannels/new`
5. `PUT /sessions/{sessionId}/datachannels/close`

Every request body uses `Content-Type: application/json`. Both the server and
browser require JSON response content types, parse the body, reject top-level or
per-channel API errors, and validate each field they use. Errors appear in the
status panel with the failed operation and a concrete retry or configuration
hint. Raw upstream bodies are not returned to the browser.

The server maintains a FIFO mutation queue for each Realtime SFU session.
`datachannels/establish`, `datachannels/new`, `datachannels/close`, and
`renegotiate` therefore cannot overlap on one session's SDP state machine. When
an operation returns `requiresImmediateRenegotiation: true`, that queue remains
blocked after returning the offer to the browser; only the matching
`/renegotiate` answer releases later mutations. A mutation rejected for a
transient unstable signaling state stays in its queue position and is retried
before any later operation can run.

The setup waits for each `RTCPeerConnection.connectionState` to become
`connected` before creating application channels, then waits for every
`RTCDataChannel.readyState` to become `open` before enabling message controls.
Both waits are bounded and surface failure or timeout states.

Teardown first closes both application channel pairs through the Realtime SFU
API. It then closes every browser `RTCDataChannel` and `RTCPeerConnection`,
which also closes the reserved `server-events` transport channel. The client
treats the API's item-level `close_track_error` as already closed, so a retry
can finish after a partially successful batch. Successful remote cleanup groups
and local objects are remembered; repeated teardown is a no-op and a failed
remote group is the only part retried.

## Tests

The test suite uses fake HTTP responses and fake WebRTC objects. It does not
need or read Realtime SFU credentials.

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript typechecking, builds the browser bundle,
runs all focused TypeScript tests, and scans `dist/app.js` for server
credential names, authorization headers, bearer values, and direct Realtime
SFU endpoint references. The individual commands are `npm run typecheck`,
`npm run build`, `npm test`, and `npm run scan:generated`.

Tests cover:

- Exact local, remote, and browser reliability settings.
- Remote-only `waitForAck` and `canReply`.
- JSON request handling and narrow route validation.
- Per-session mutation serialization across the complete offer/answer cycle.
- Retention and retry of a transient unstable-signaling mutation.
- Upstream and browser response validation.
- Credential-safe browser assets and error responses.
- Connected/open waits.
- Idempotent local and remote teardown, retry, and stopped sends.

## Known limitations

- Both endpoints run in one page to keep the primitive inspectable. There is no
  room membership, discovery, persistence, or cross-browser signaling.
- The example has no reconnection flow. Teardown and reconnect create fresh
  Realtime SFU sessions.
- The single subscriber demonstrates reply access but not transferring
  exclusive `canReply` access between subscribers.
- `maxRetransmits: 0` permits loss but does not force it. This is not a latency,
  delivery-rate, or performance measurement.
- Explicit teardown is tested. Closing the process or browser abruptly can
  interrupt the cleanup requests.
- If a browser cannot apply an outstanding SFU offer, that session's mutation
  queue remains blocked rather than allowing later operations into unstable
  SDP state. Teardown and reconnect with fresh sessions.
- A public deployment needs application authentication, authorization,
  ownership checks, abuse controls, origin policy, and operational cleanup.
