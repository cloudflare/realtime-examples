# Troubleshooting

## Find the first failed request

Enable **Preserve log** in the browser's Network panel before reproducing a
failure or refreshing. Record the first failed operation, HTTP status,
`error.code`, and `x-request-id` when available. A connection failure may have
no HTTP response; record the operation and browser error. The request ID uses
`Cf-Ray` when available and a UUID locally; it is separate from a reconnect or
media mutation ID. Keep credentials, member capabilities, and Access JWTs out
of reports.

## Media setup fails after joining

Join can confirm membership before publishing and subscribing finish. If setup
stops, select **Join room** again or refresh the same room URL. The browser uses
saved membership to replace the media sessions. Preserve tab storage so it can
resume that identity. After deploying an update, reload open tabs to load the
new client.

In this example, `already_published` means `/publish` targeted a generation that
already has registered publications. It can follow an earlier setup failure.
If retry or refresh does not recover, inspect the
[first failed request](#find-the-first-failed-request). An adaptation must save
confirmed membership before media setup and use `/reconnect` when rebuilding
media sessions. See [the signaling flow](ARCHITECTURE.md#signaling-and-state-flow).

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
Use the request ID to correlate Worker logs.

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

## Notification ticket is rejected

Tickets expire after 30 seconds and can be consumed once. The browser should
request a fresh ticket and retry with bounded backoff. Confirm the ticket is in
the offered `ticket.<value>` `Sec-WebSocket-Protocol` token, not the URL, and
that the server selects only the fixed notification protocol.

## A mutation reports negotiation timed out

The browser did not complete an immediate SFU offer within 15 seconds. The
session queue is invalidated so later work is not applied to ambiguous SDP
state. If recovery stops, refresh the room to replace both sessions. For
repeated failures, inspect signaling-state transitions and the first failed
`/subscribe` or `/renegotiate` request.

## Refresh creates a reconnect loop

The tab keeps its client ID and member token in `sessionStorage`. Verify storage
is enabled and the direct room URL did not change. Use **Open another
participant** for another tab; **Duplicate Tab** can copy the first tab's
identity. Clearing storage discards the capability needed to resume membership.

Concurrent identical reconnect requests should return the same media
generation. A `media_generation_stale` response means the operation targets
replaced or invalidated media state. The active room reconnects when background
synchronization receives this code. Do not apply old SDP to replacement sessions.

## A departed participant remains visible

Explicit Leave should normally converge after a revision notification. If the
socket is unavailable, check the 15-second safety poll. An inactive participant
becomes eligible for cleanup after 45 seconds by default; failed cleanup can
delay removal. Confirm Durable Object alarms are running and
`ROOM_STALE_SECONDS` is between 20 and 300. See
[cleanup behavior](ARCHITECTURE.md#cleanup) for expiry and termination.

## Leave or terminate appears stuck

Cleanup can wait behind an outstanding SDP answer or its 15-second timeout.
The browser closes PeerConnections during teardown but retains membership and
capture until cleanup is confirmed. If cleanup fails, retry **Leave** or
**Terminate room** using the retained controls. Inspect the failing request
before clearing tab state; the backend retains known mids for cleanup retries.

## An SFU request timed out

`sfu_request_timed_out` means the SFU client did not receive response headers
within ten seconds. This timer does not cover reading the response body.
Retrying that operation keeps its mutation ID and prepared SDP; starting a new
media setup uses `/reconnect` and the returned generation. For repeated
timeouts, record the failing operation and request IDs while preserving
membership.

## Remote video exists but does not play

The Join button provides the user gesture normally required for autoplay.
Check browser autoplay policy, verify the remote video has a `MediaStream` with
audio/video tracks, and inspect inbound `getStats()` values. Listen for remote
audio manually; a live track alone does not prove audible speaker output.

## Browser credential scan fails

Run:

```bash
npm run build
npm run scan:browser
```

Remove any SFU binding names or direct authenticated SFU calls from generated
browser assets. All Realtime SFU requests must remain in `src/server/`.
