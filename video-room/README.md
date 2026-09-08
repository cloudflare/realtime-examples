# Custom video room

> Example status: **Experimental**

This blueprint deploys a small two-way browser video room using raw Cloudflare
Realtime SFU HTTPS operations. Each participant publishes camera/microphone
tracks and subscribes to every other active participant.

It is intentionally restrained: a minimal application demonstrating public
Realtime SFU APIs and production-minded application boundaries, not a
conferencing product.

After joining, you see named local and remote video tiles, a participant count,
a Leave button, and a creator-only room termination control. A direct URL such
as `/rooms/design-review` identifies the room but does not authorize access.

## Components

- A browser uses separate producer and consumer `RTCPeerConnection` instances
  so the two media directions and their negotiation queues are easy to inspect.
  A single bidirectional connection is also a valid application design.
- A Worker authenticates every public HTTP request, maps room operations to
  typed Durable Object RPC methods, and keeps SFU credentials server-side.
- One Durable Object per room owns presence, track discovery, membership
  capabilities, authorization, notification tickets, reconnect state, and
  stale cleanup.
- A hibernating Durable Object WebSocket sends revision-only room-change
  notifications; HTTP remains authoritative for every snapshot and mutation.
- Cloudflare Realtime SFU forwards audio and video between browser sessions.

No external conferencing SDK or application service is required. A Cloudflare
account with Workers, Durable Objects, Realtime SFU, and Cloudflare Access is
required for a deployed room.

## Run locally with live SFU media

Use Node.js 22 or newer. The Cloudflare Vite plugin reads local secrets from the
standard ignored `.dev.vars` file. Create it with owner-only permissions, then
remove it after validation:

```bash
cd video-room
npm ci
npm run check

export REALTIME_SFU_APP_ID='<temporary-app-id>'
read -rsp 'temporary SFU token: ' REALTIME_SFU_BEARER_TOKEN
export REALTIME_SFU_BEARER_TOKEN

(umask 077
  for name in REALTIME_SFU_APP_ID REALTIME_SFU_BEARER_TOKEN; do
    printf '%s=' "${name}"
    printenv "${name}"
  done > .dev.vars
)
unset REALTIME_SFU_BEARER_TOKEN

npm run dev
```

`npm run dev` starts Vite on port `8787` and reloads browser code, HTML, and CSS
as they change.

Open `http://localhost:8787/rooms/two-browser-check` in Google Chrome and join
as the first participant. Select **Open another participant** beside
**Copy link**, then join with another name in the fresh tab. Both tabs in the
same Chrome profile should show two named tiles with the other participant's
audio and video.

Do not use Chrome's **Duplicate Tab** action: duplicated tabs can inherit
`sessionStorage` and reuse the first participant's client identity. Separate
Chrome profiles are optional only when testing distinct Cloudflare Access
identities.

This blueprint is the canonical Realtime example for composing one Durable
Object per room with WebSocket Hibernation. The Durable Object owns room state
and coordination; `acceptWebSocket()`, bounded participant attachments, and
`getWebSockets()` provide revision notifications only. HTTP remains
authoritative for snapshots, SDP, authorization, mutations, and cleanup.

The browser-facing API remains HTTP. After authentication, the Worker obtains a
named Durable Object stub and calls typed RPC methods for ordinary room
operations. Expected outcomes return as plain tagged success or error values,
which the Worker maps back to HTTP. Only the notification WebSocket upgrade uses
`fetch()` on the Durable Object stub.

After joining, each browser obtains a 30-second, single-use notification ticket
from an authenticated HTTP endpoint. The ticket is sent in the WebSocket
handshake, never in the URL: the browser offers the fixed notification protocol
and a `ticket.<value>` `Sec-WebSocket-Protocol` token, while the server selects
only the fixed protocol. Socket open and `room-changed` notifications
immediately resync the existing HTTP snapshot/subscription path. A periodic
15-second HTTP poll provides a separate convergence check.

Before join, the browser creates a random member capability and reuses it for
identical retries; the Durable Object stores only its hash. Reconnect requests
carry an idempotency ID, and every SDP mutation carries the media generation it
was created for. Transient reconnect, publish, or subscribe setup failures are
retried up to three times before heartbeat, notifications, and safety polling
resume for continued recovery.

`npm run dev` explicitly overrides authentication to `local`. The checked-in
and deployed default is `cloudflare-access`; missing `AUTH_MODE` also fails
closed. The browser sends a development identity only on `localhost`, and a
deployed host explicitly forced to local mode still rejects every API request.

## Deploy

1. Put the Worker hostname behind a Cloudflare Access application.
2. Export the Access team domain, Access application audience, temporary SFU
   application ID, and temporary SFU bearer token in your shell.
3. Deploy the code and then add the bearer token as a Worker secret:

```bash
export CF_ACCESS_TEAM_DOMAIN='<team-name>.cloudflareaccess.com'
export CF_ACCESS_AUD='<access-application-audience>'
export REALTIME_SFU_APP_ID='<temporary-app-id>'
read -rsp 'temporary SFU token: ' REALTIME_SFU_BEARER_TOKEN
export REALTIME_SFU_BEARER_TOKEN

npm run deploy -- \
  --var "CF_ACCESS_TEAM_DOMAIN:${CF_ACCESS_TEAM_DOMAIN}" \
  --var "CF_ACCESS_AUD:${CF_ACCESS_AUD}" \
  --var "REALTIME_SFU_APP_ID:${REALTIME_SFU_APP_ID}"

printf %s "${REALTIME_SFU_BEARER_TOKEN}" |
  npx wrangler secret put REALTIME_SFU_BEARER_TOKEN
```

Open the deployed `/rooms/two-browser-check` URL in one Google Chrome tab,
join, then select **Open another participant** for the second fresh tab. Both
tabs can share one Access identity while keeping separate participant
identities in fresh `sessionStorage`. Use separate profiles only when the test
specifically requires distinct Access identities. Do not use Duplicate Tab.

## Validate two endpoints

`npm run check` combines two test layers:

- `npm run test:unit` runs deterministic application state, queue, validation,
  and browser-controller tests.
- `npm run test:workerd` runs Worker and Durable Object integration tests for
  typed RPC, bindings, persisted state, alarms, eviction, and hibernating
  WebSockets.

The check also verifies that the generated `worker-configuration.d.ts` matches
`wrangler.jsonc` and the exported Worker classes. Run `npm run cf-typegen` after
changing either boundary.

The opt-in Playwright test uses two fresh pages in one Google Chrome browser
context, fake camera devices, the local Vite Worker, and the real SFU path. It
clicks **Open another participant** and verifies that the second page receives
fresh `sessionStorage`. It contains no SFU credentials:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

Validate an Access-protected deployment manually. Sign in through Access in
Google Chrome, then run the same primary flow in two fresh tabs within that
authenticated profile. Separate profiles are optional distinct-identity
coverage, not the normal room journey. Playwright does not validate the Access
login, policy, cookie, or JWT delivery.

The test proves named local/remote tiles, remote audio and video tracks,
refresh/rejoin without duplicate presence, revision-notification convergence,
leave/rejoin, peer-visible room termination, and local cleanup in both
browsers. Confirming that remote audio is actually audible remains a manual
Chrome check. In Chrome DevTools, the notification socket URL must contain no
token/ticket query parameter and server frames must contain only
`room-changed` plus `revision`.

Task validation uses Google Chrome. Other supported browsers remain useful
follow-up coverage.

## Stop and clean up

Stop local development with `Ctrl-C`. For a deployed validation Worker:

```bash
rm -f .dev.vars
npx wrangler delete --name realtime-video-room-blueprint --force
unset REALTIME_SFU_APP_ID REALTIME_SFU_BEARER_TOKEN
unset CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD
```

The Leave button closes published and subscribed tracks. Browser media,
membership tokens, and room controls are cleared only after the API confirms
cleanup; a failure remains visible and retryable. Abandoned participants stop
appearing after 45 seconds after the Durable Object alarm successfully
force-closes their known SFU track mids. A transient forced-close failure keeps
presence active and schedules another alarm attempt. Cleanup seals new media
mutations, drains active operations, and closes all recorded mids before
presence changes. Repeated close responses that identify a track as already
absent are accepted; other per-track errors preserve state for retry. Cleanup
operations are idempotent within the five-minute membership tombstone window.

## Documentation

- [Architecture and lifecycle](ARCHITECTURE.md)
- [Production integration](PRODUCTION.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Coding-agent invariants](AGENTS.md)

## Known limitations

- This is an experimental reference, not a hosted service or production
  certification.
- Room-change delivery uses a notification-only hibernating WebSocket with a
  periodic 15-second safety poll; it is not a second signaling protocol.
- A closed or crashed tab may remain visible for up to 45 seconds.
- Camera/microphone replacement reconnects both media sessions instead of
  reusing a transceiver.
- Simulcast, screen sharing, chat, recording, end-to-end encryption,
  moderation, and advanced layouts are intentionally unavailable.
- Application rate limiting, room quotas, audit storage, and Access policy
  creation remain deployment responsibilities.
