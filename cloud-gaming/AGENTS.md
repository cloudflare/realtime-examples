# Cloud Gaming Agent Instructions

These instructions apply to `cloud-gaming/`.

## Goal

Keep this a complete but small Realtime SFU application: one Freedoom
Container, multiple viewers, and one controlling browser tab. Do not turn it
into a game-hosting platform.

## Code Map

- Browser and HTTP boundary: `src/client/`, `src/worker.ts`, and
  `src/server/auth.ts`.
- Application state and SFU operations: `src/server/game-container.ts`,
  `src/server/*-domain.ts`, `src/server/run-*.ts`, and
  `src/server/realtime.ts`.
- Shared browser/Worker contracts: `src/shared/`.
- Structured Worker logging: `src/server/logger.ts`.
- Native publisher, media capture, and input injection: `publisher/`.
- Design and operations: `ARCHITECTURE.md`, `PRODUCTION.md`, and
  `TROUBLESHOOTING.md`.

## Security

- Keep Realtime SFU credentials in the Worker. Never expose them through
  browser code, responses, logs, URLs, or checked-in configuration.
- Verify Cloudflare Access identity for every browser API. Local identity is
  allowed only on loopback hosts.
- Bind each viewer capability to its Access principal. IDs and media locators
  are not authorization.
- Keep Container signaling on the platform-provided Container identity. Do not
  add a publisher bearer token or expose its routes publicly.
- Validate browser, Container, environment, SFU response, and native input
  boundaries.
- Keep logs to bounded application identifiers, phase names, states, and error
  codes. Never log credentials, capabilities, SDP, or ICE candidates.

## Lifecycle

- One named `GameContainer` owns the run, viewers, controller generation,
  Container lifecycle, and SFU cleanup ledger.
- Persist `starting` before launching the Container. Container acquisition and
  publisher readiness have separate deadlines; ignore late work from an old
  run generation.
- Application state owns the idle and maximum-runtime limits.
  `Container.sleepAfter` is only a longer safety fallback.
- Serialize SFU mutations per session. Start, stop, leave, release, and cleanup
  must remain idempotent.
- Release held input when control changes, the viewer expires, pointer lock is
  lost, the publisher fails, or the run stops.
- Close known SFU resources before deleting their state. Use inactivity expiry
  only after bounded cleanup attempts and confirmed Container shutdown.
- End the run when the media pipeline fails. Do not add transparent publisher
  restart without preserving media and application continuity.

## Realtime SFU

- The Container publishes H.264 video and Opus audio.
- Each browser tab uses one SFU session and one PeerConnection for both media
  and input DataChannels.
- Follow the server-offer, endpoint-answer, and renegotiation sequence before
  creating application DataChannels.
- `src/shared/input-channels.ts` owns TypeScript channel names and reliability:
  reliable ordered controls, and unordered pointer movement with
  `maxRetransmits: 0`.
- Viewers subscribe with `waitForAck: true` and `canReply: false`, then
  acknowledge each channel when it opens.
- Grant and revoke control with `datachannels/update` on the existing
  subscriptions. Do not create another session or negotiate again.
- Treat the controller generation as authorization state. Enable browser input
  only after the publisher confirms the selected viewer and generation.
- `running` means publisher media and both input DataChannels are ready.

## Scope

- Keep one fixed slot and `max_instances: 1`. Do not add a launcher, slot
  index, game picker, placement selector, or user-selected Container name.
- Keep state scoped to the named `GameContainer` so a future application can
  add validated slot routing without replacing the design.
- Do not add PartyTracks, PartyKit, a conferencing abstraction, or a large SFU
  SDK.
- Use the existing Hono, Zod, React, and Tailwind structure. Add dependencies
  only when they remove more application code than they introduce.
- Do not make unsupported latency, scale, availability, or production claims.

## Verification

Run the checks declared in `blueprint.yaml`.

- Keep tests focused on authorization, generations, cleanup, input, and
  reliability rather than simulating the platform.
- Use the Workers Vitest integration for Worker and Durable Object behavior.
- When native runtime or Container behavior changes, also build the Dockerfile
  for `linux/amd64`.
- When the architecture diagram changes, run `npm run diagram` and commit both
  `architecture.mmd` and `architecture.svg`.
