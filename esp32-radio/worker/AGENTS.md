# Exhibit application

This directory owns the React frontend and Cloudflare backend.

Use Tailwind v4 utilities for layout, typography, controls, and responsive
behavior. Keep custom CSS focused on theme tokens and drawing effects.
Run Prettier after edits. Keep the high-frequency spectrum renderer outside
full-page renders.

Organize exhibit components by responsibility under src/client/exhibit/.
The exhibit maps radio state to narrow panel props; panels do not own or import
RadioSession. Keep the board SVG separate from board layout, wire geometry
separate from DOM measurement, and explanation copy separate from popover logic.
src/client/radio/use-radio.ts is the React boundary for the session owner.
Use named API operations with Zod-inferred outputs and direct module imports.

Show measured telemetry; unavailable readings are not zero. Distinguish shared
LED/playback changes from local volume/mute. Preserve offline exploration,
phone layouts, keyboard access, reduced motion, and state cues beyond color.

Use Hono for HTTP routing and cookie handling, shared Zod schemas for JSON
boundaries, and typed RPC for Worker-to-Durable-Object operations. Generate Env
with Wrangler; secret names belong in wrangler.jsonc's secrets.required, never
in a duplicate handwritten Env interface. Keep RPC errors serializable.

RobotRoom owns one board's sessions, controller lease, and cleanup. Preserve
its class name, persisted state shape, and migration history during compatible
rollouts. Keep SFU mutations serialized across awaits, revoke canReply when a
lease expires within the current generation, and retain failed allocations and
viewer cleanup while that generation is current. A replacement or expired
publisher retires its whole generation without SFU cleanup blocking a new boot.
Persist retirement before allocating the replacement. This does not establish
that obsolete SFU forwarding or reply access has stopped. Keep request-level
SFU errors pending; a status code alone does not prove cleanup or revocation.
Status polling must not postpone an existing alarm. Firmware API paths and
data-channel formats must remain compatible with the connected board.

Check with make check, make test-worker and make test-worker-bundle from esp32-radio/. Live tests in
tests/live.mjs require the board, SFU, credentials, and a Chrome CDP endpoint.
Document integration workarounds in ../ERRATA.md.

Use @/, @dev/ and @tests/ for imports across directories; the shared alias map
and Node preload live in dev/. Worker runtime tests use Cloudflare Vitest with
synthetic bindings and reset storage between cases. Keep the production-bundle
smoke test independent of the runner's extra compatibility flags.
