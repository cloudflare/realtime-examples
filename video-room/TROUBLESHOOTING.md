# Troubleshooting

## The deployed room says local identities are disabled

The Worker was deployed with `AUTH_MODE=local`. Redeploy with
`AUTH_MODE=cloudflare-access`, configure `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD`, and put the hostname behind the matching Access application.
The local mode intentionally cannot work on a deployed hostname.

The checked-in Wrangler default is already `cloudflare-access`. Only
`npm run dev` opts into local authentication.

## Access authentication is missing or invalid

Confirm the request passes through the Access application, the team domain has
no scheme prefix, and the audience belongs to that exact Access application.
Use the response request ID to correlate safe Worker logs. Do not log or paste
the JWT.

## Join reports that Realtime SFU is not configured

Set `REALTIME_SFU_APP_ID` on the Worker and add
`REALTIME_SFU_BEARER_TOKEN` with `wrangler secret put`. Do not put either value
in `index.html`, `src/client/`, generated browser assets, query parameters, or
screenshots. For local development, use the ignored mode-600 `.dev.vars` flow
in the README; do not pass the bearer token as a command argument.

## Camera or microphone permission was denied

Allow both devices for the origin and retry. This blueprint currently requests
camera and microphone together; single-device fallback and device replacement
are not implemented.

## The local tile appears but the remote participant does not

1. Confirm both browsers use exactly the same `/rooms/<room-name>` URL.
2. Confirm both names appear in the participant count and named tiles.
3. Inspect the response to `/snapshot`; the remote participant should expose
   published audio/video track keys.
4. Inspect `/subscribe` and `/renegotiate` response codes and request IDs.
5. Check both consumer PeerConnections for `connectionState=connected`.

If `/subscribe` returns an offer, its matching `/renegotiate` answer must
finish before any later mutation on that consumer session.

## Room changes appear only after a delay

The notification socket may be disconnected. The application still polls the
authorized HTTP snapshot every 15 seconds. Check the `/socket-ticket` request,
the `/socket` WebSocket upgrade, and browser reconnect attempts. A successful
socket open immediately resyncs the HTTP snapshot.

The WebSocket never carries snapshots, SDP, or track locators. Seeing only a
small `room-changed` revision message is expected.

## Notification ticket is rejected

Tickets expire after 30 seconds and can be consumed once. The browser should
request a fresh ticket and retry with bounded backoff. Confirm the ticket is in
the offered `ticket.<value>` `Sec-WebSocket-Protocol` token, not the URL, and
that the server selects only the fixed notification protocol. The member token
used for notification setup is sent to the authenticated `/socket-ticket` HTTP
endpoint.

## A mutation reports negotiation timed out

The browser did not complete an immediate SFU offer within 15 seconds. The
session queue is invalidated so later work is not applied to ambiguous SDP
state. Let the visible reconnect path replace producer and consumer sessions.
If this repeats, inspect browser signaling-state transitions and the safe SFU
error code associated with the request ID.

## Refresh creates a reconnect loop

The tab keeps its client ID and member token in `sessionStorage`. Verify storage
is enabled and the direct room URL did not change. A successful reconnect
reuses the participant ID and replaces both SFU sessions. Clearing tab storage
creates a new membership; the old one remains only until stale cleanup.

Concurrent identical reconnect requests should return the same media
generation. A `media_generation_stale` response means an old browser operation
arrived after replacement; do not rewrite it onto the new session.

## A departed participant remains visible

Explicit Leave should normally converge after a revision notification. If the
socket is unavailable, the periodic 15-second safety poll still converges. A
closed or crashed tab has no reliable unload handshake and remains until its
heartbeat is stale, 45 seconds by default. Confirm Durable Object alarms are
enabled and `ROOM_STALE_SECONDS` is between 20 and 300.

Closing the notification socket intentionally does not remove presence.

After creator termination, left member tokens remain authorized only for the
bounded terminal snapshot window. A peer should observe the termination
message, return to the lobby, and remove its media tiles.

## Leave or terminate appears stuck

Cleanup waits behind an in-progress SDP cycle. The browser should apply the
outstanding offer and send `/renegotiate`; otherwise the 15-second queue timeout
forces reconnect cleanup. Repeating Leave or creator Terminate is safe during
the five-minute membership tombstone window. If cleanup returns an error, the
room UI and member token remain present; retry the same control after the
transient failure clears.

Forced cleanup waits for active SFU work and seals or invalidates later work.
If an alarm close fails, presence remains active and another alarm is scheduled.
Per-track close errors returned under HTTP 200 have no independent HTTP status.
The already-absent result can converge cleanup; other item errors remain
retryable rather than being assigned a status from their text.

## An SFU request timed out

Each server-side SFU request aborts after ten seconds and returns
`sfu_request_timed_out` as retryable. Retry with the same mutation ID. Repeated
timeouts indicate an external connectivity or service problem rather than a
reason to discard room state.

## Remote video exists but does not play

The Join button provides the user gesture normally required for autoplay.
Check browser autoplay policy, verify the remote video has a `MediaStream` with
audio/video tracks, and inspect inbound `getStats()` values. Task validation
uses Google Chrome with fake media device and permission flags.

## Browser credential scan fails

Run:

```bash
npm run build
npm run scan:browser
```

Remove any SFU binding names or direct authenticated SFU calls from generated
browser assets. All Realtime SFU requests must remain in `src/server/`.
