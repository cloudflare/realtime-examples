# Custom video room

> Example status: **Experimental**

Build a small browser video room with raw Cloudflare Realtime SFU operations.
Participants publish camera and microphone tracks and receive everyone else in
the room.

## Run locally

Use Node.js 22.12 or later:

```bash
cd video-room
npm ci
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Set `REALTIME_SFU_APP_ID` and `REALTIME_SFU_BEARER_TOKEN` in `.dev.vars`, then:

```bash
npm run dev
```

Open `http://localhost:8787/rooms/two-browser-check`, join, and select
**Open another participant**. Join from the new tab with a different name. Both
tabs should show local and remote audio and video.

Do not use Chrome's **Duplicate Tab** action. It can copy `sessionStorage` and
reuse the first participant's browser identity.

## How it works

![Video room architecture](architecture.svg)

Each browser uses separate producer and consumer PeerConnections, each with
its own SFU session and negotiation queue.

The Worker uses Hono for HTTP routing and Zod to validate requests before
calling one Durable Object per room through typed RPC. The Durable Object owns
membership, authorization, track discovery, reconnect, and cleanup. Media flows directly between the browser and Realtime SFU, while
SFU credentials remain in server-side bindings.

A hibernating WebSocket sends only `room-changed` revisions. HTTP remains
authoritative for snapshots, SDP, and mutations, with a 15-second safety poll.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete signaling and lifecycle
design.

The frontend uses React 19 and Tailwind CSS v4 through Vite. Edit
`src/client/App.tsx` for the layout and participant tiles. React subscribes to
`src/client/room-controller.ts`, which owns room actions and media lifetimes.
`src/client/styles.css` holds the Tailwind import and shared focus style.

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

Check types, application behavior with mocked SFU responses, the production
build, and browser assets for credentials:

```bash
npm run check
```

With the dev server running, the optional live test uses Google Chrome, fake
camera/microphone input, and real SFU connections:

```bash
LIVE_VIDEO_ROOM_URL='http://localhost:8787' npm run test:live
```

It checks two participants exchanging media, interrupted initial setup and
refresh recovery, Leave/rejoin, and creator termination. Listen for remote
audio manually. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for failures.

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

- Inactive participants become eligible for cleanup after 45 seconds by
  default. Failed cleanup is retried.
- Recovery after repeated reconnect setup failures may require a page reload.
- Audible speaker output remains a manual check.
- DataChannels, simulcast, screen sharing, chat, recording, end-to-end
  encryption, moderation, device switching, and advanced layouts are not
  implemented.
- Rate limiting, room quotas, audit storage, and Access policy creation remain
  deployment responsibilities.

Coding agents should also read [AGENTS.md](AGENTS.md).
