# Exhibit application

The browser receives audio and telemetry and sends control commands through
Realtime SFU. A Worker and Durable Object handle the application signaling for
the [firmware connection](../firmware/docs/sfu.md).

This guide covers local development, code organization, and tests. All Makefile
commands run from `esp32-radio/`. Framework versions are pinned in
[package.json](package.json); bundled fonts retain their
[license notices](public/fonts/LICENSE.txt).

## Local development

For frontend-only work, use Node 24 and run from `esp32-radio/`:

```sh
make setup-web
make dev
```

Open `http://localhost:11880`. This starts a local Worker with independent room
state; a board publishing to a deployed Worker will appear offline here.
For frontend work with that board, prepare credentials with the
[root setup](../README.md#set-up) and use the explicit live API proxy instead.
The firmware toolchain is needed only when building or flashing the board:

```sh
export SIGNALING_URL=https://radio.example.com
make dev-live
```

Use your deployed origin. The proxy forwards viewer APIs, including login, to
that Worker. It requires the viewer password; device endpoints are not proxied.
Audio and data travel through the SFU. Only one dev server can use port
11880 at a time.

For a phone, allow the development machine's LAN IP or a hostname that resolves
on both devices. Put the value in ignored `worker/.env.local`:

```dotenv
RADIO_DEV_HOSTS=192.168.1.20
```

Replace the example with your machine's address, restart the dev server, and
open `http://192.168.1.20:11880` on the phone. Comma-separated entries configure
both Vite and the proxy; use exact hostnames/IPs without schemes or ports.
The phone must reach the development machine on its LAN. Loopback hosts are
allowed by default; the Worker's local authentication bypass is limited to them.

## Deployment

Follow the [README setup](../README.md#set-up) for the account, domain, secrets,
and initial deployment. Use [operations](../PRODUCTION.md) for rotation,
compatible updates, rollback, and shutdown.

## Code map

| Location                                                                                  | Responsibility                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [src/client/App.tsx](src/client/App.tsx)                                                  | Application shell and radio lifecycle                         |
| [src/client/exhibit/](src/client/exhibit/)                                                | Board illustration, panels, diagram and explanations          |
| [src/client/radio/](src/client/radio/)                                                    | Session ownership, React subscription, typed API and decoding |
| [src/client/ui/](src/client/ui/)                                                          | Icons, login and display formatting                           |
| [src/shared/contracts/](src/shared/contracts/)                                            | Zod schemas and inferred wire types                           |
| [src/server/index.ts](src/server/index.ts), [routes/](src/server/routes/)                 | Authentication and Hono routing                               |
| [robot-room.ts](src/server/robot-room.ts), [room-state.ts](src/server/room-state.ts)      | Durable Object coordination and persisted state               |
| [sfu.ts](src/server/sfu.ts)                                                               | SFU timeouts, allocation receipts and validation              |
| [auth.ts](src/server/auth.ts), [http.ts](src/server/http.ts), [rpc.ts](src/server/rpc.ts) | Cookies, input validation and serializable errors             |

## Session and media flow

The exhibit passes each panel only the radio-state fields it needs; panels do
not receive the complete `RadioSession`. `use-radio.ts` creates the session,
subscribes React to its snapshots and attaches the audio element. `session.ts`
manages the peer, audio playback, connection lifecycle, timers, command
acknowledgments and cleanup. `playback.ts` accepts metadata updates in revision
order and combines them with telemetry to produce the displayed playback state.

The spectrum canvas reads the board's 25 Hz sample buffer directly, while React
state updates at a lower frequency. See [architecture](../ARCHITECTURE.md) for
authentication, viewer admission, controller leases, and cleanup policy.

`RobotRoom` retires replaced or expired publisher generations independently of
old SFU cleanup. Within the current generation, it retains allocation receipts
and failed viewer cleanup, and revokes controller permission before handoff.
See the [lifecycle policy](../ARCHITECTURE.md#cleanup-and-failure-behavior) for
retry, expiry, and access-revocation boundaries.

The board includes current-song metadata in its HTTPS heartbeats. The status API
returns the last accepted metadata before a browser establishes WebRTC;
connected browsers also receive metadata changes over the reliable data
channel. Both sources include a playback revision. Within one publisher
generation, the browser accepts only newer metadata revisions from either
source. A generation change clears the accepted metadata; telemetry and spectrum
packets that carry revisions must match the accepted playback revision. See
[Change the playlist](../README.md#change-the-playlist) for the replacement
workflow.

Wrangler generates `worker-configuration.d.ts` from bindings and required
secret names, including in CI without real credentials.

Imports across directories use `@/` for `src/`, `@dev/` for `dev/`, and `@tests/`
for `tests/`; neighboring modules can keep `./` imports. Vite and test tooling
share [dev/aliases.ts](dev/aliases.ts), with matching TypeScript paths in
[tsconfig.paths.json](tsconfig.paths.json). Direct Node runs that import aliased
modules need the preload hook, for example:

```sh
node --import ./dev/register-aliases.mjs --test src/client/radio/*.test.ts
```

## Worker tests

`make test-worker` runs TypeScript tests under `tests/runtime/` through the
Cloudflare Vitest plugin. The source Worker and Durable Object execute in a
local Workers runtime with generated binding types, synthetic credentials and
an intercepted SFU. Cases reset storage between tests; no real account or board
is needed. From `worker/`, `npm run test:worker:watch` reruns cases as code changes.

Vitest has a separate [configuration](vitest.config.ts), sharing only the import
aliases with the frontend. It does not start the live API proxy. Versions are
pinned together in `package.json` because the Cloudflare plugin supports a
specific Vitest range.

`make test-worker-bundle` builds the application and checks the production bundle
and scheduled controller-lease expiry in Miniflare with production compatibility
settings. Source tests exercise alarms and eviction through the plugin helpers.
Both suites share the synthetic SFU and API client in `tests/helpers/`.

`npm test` runs portable protocol and state tests with Node's test runner.
Run `make check` for all type checks, portable tests and formatting. CI runs these
checks and both Worker suites.

## Browser tests

The browser scripts connect to an existing Chrome DevTools Protocol endpoint.
Start a dedicated Chromium instance in a separate terminal; substitute your
installed Chromium/Chrome executable if needed:

```sh
chromium --headless=new --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=19223 --user-data-dir="$(mktemp -d)" about:blank
```

With `make dev` running, execute from `worker/`:

```sh
export RADIO_CDP_URL=http://127.0.0.1:19223
RADIO_TEST_URL=http://localhost:11880 node tests/layout.mjs
RADIO_TEST_URL=http://localhost:11880 node tests/popovers.mjs
RADIO_TEST_URL=http://localhost:11880 node tests/states.mjs
```

`layout.mjs` and `popovers.mjs` supply an offline board fixture. `states.mjs`
uses the real app with a fixture at its React/session boundary to check geometry,
long metadata, keyboard focus and pending-action guards. It needs Vite dev mode.
These fixture modules are not entry points in the production build.

For the hardware test, use the deployed
Worker URL, or the local URL when running `make dev-live`:

```sh
RADIO_TEST_URL=https://radio.example.com \
RADIO_EXPECT_TRACK='Your track title' node tests/live.mjs
```

`RADIO_EXPECT_TRACK` is optional. Set `RADIO_EXPECT_PLAYLIST=1` to exercise Next
without reconnecting, and `RADIO_EXPECT_AUTO_ADVANCE=1` when testing a short
synthetic playlist (songs must end within the test's 45-second wait). The test reads the viewer password from
the root `.credential.env`, opens two listeners, and changes the LED and shared playback.
It checks audio, spectrum, measured hardware telemetry, metadata, and controller handoff. Close other test
listeners first. Results and screenshots go to ignored `artifacts/worker/`.
