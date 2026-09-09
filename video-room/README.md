# Custom video room

> Example status: **Experimental**

Build a small browser video room with raw Cloudflare Realtime SFU operations.
Participants publish camera and microphone tracks and receive everyone else in
the room.

## Run locally

Use Node.js 22 or later:

```bash
cd video-room
npm ci
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Set `REALTIME_SFU_APP_ID` and `REALTIME_SFU_BEARER_TOKEN` in `.dev.vars`, then:

```bash
npm run check
npm run dev
```

Open `http://localhost:8787/rooms/two-browser-check`, join, and select
**Open another participant**. Join from the new tab with a different name. Both
tabs should show local and remote audio and video.

Do not use Chrome's **Duplicate Tab** action. It can copy `sessionStorage` and
reuse the first participant's browser identity.

## How it works

![Video room architecture](architecture.svg)

Each browser uses separate producer and consumer PeerConnections. A single
bidirectional connection is also valid when publish and subscribe operations
share one serialized offer/answer lifecycle.

The Worker authenticates HTTP requests and calls one Durable Object per room.
The Durable Object owns membership, authorization, track discovery, reconnect,
and cleanup. Media flows directly between the browser and Realtime SFU, while
SFU credentials remain in server-side bindings.

A hibernating WebSocket sends only `room-changed` revisions. HTTP remains
authoritative for snapshots, SDP, and mutations, with a 15-second safety poll.

The initial join sends a browser-generated member capability in its JSON body.
Later requests use the `x-room-member-token` header. Notification tickets are
short-lived, single-use, and sent through `Sec-WebSocket-Protocol`, never a URL.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete signaling and lifecycle
design.

## Deploy

A deployed room requires Workers, Durable Objects, Realtime SFU, and a
Cloudflare Access application protecting the Worker hostname.

```bash
export CF_ACCESS_TEAM_DOMAIN='<team-name>.cloudflareaccess.com'
export CF_ACCESS_AUD='<access-application-audience>'

npm run deploy -- \
  --secrets-file .dev.vars \
  --var "CF_ACCESS_TEAM_DOMAIN:${CF_ACCESS_TEAM_DOMAIN}" \
  --var "CF_ACCESS_AUD:${CF_ACCESS_AUD}"
```

Open `/rooms/two-browser-check` on the protected hostname and repeat the
two-tab flow. Validate Access manually in Chrome; the local browser test does
not test Access policy, cookies, or JWT delivery.

See [PRODUCTION.md](PRODUCTION.md) before changing authentication,
authorization, quotas, retention, or observability.

## Verify

```bash
npm run check
```

The optional live test uses two fresh Chrome pages and the real SFU path:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

Also verify refresh, Leave and rejoin, creator termination, and audible remote
audio. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for failures.

## Clean up

Use **Leave** for one participant or **Terminate room** for the complete room.
Failures remain visible so cleanup can be retried.

```bash
npx wrangler delete
rm -f .dev.vars
unset CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD
```

Remove the Access application separately.

## Known limitations

- A closed or crashed tab may remain visible for up to 45 seconds.
- Camera or microphone replacement reconnects both media sessions.
- Recovery after repeated reconnect setup failures may require a page reload.
- Audible speaker output remains a manual check.
- Simulcast, screen sharing, chat, recording, end-to-end encryption,
  moderation, device switching, and advanced layouts are not implemented.
- Rate limiting, room quotas, audit storage, and Access policy creation remain
  deployment responsibilities.

Coding agents should also read [AGENTS.md](AGENTS.md).
