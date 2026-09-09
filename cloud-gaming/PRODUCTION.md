# Production guidance

This blueprint is experimental. Use the sections below as integration
boundaries rather than a claim that the included deployment fits every
production environment.

## Authentication

Protect the complete application hostname with Cloudflare Access.

Configure the Worker with the Access application audience and team domain. The
Worker verifies the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and
subject before accepting any browser API operation.

Local authentication is a development mode restricted to loopback hosts. It is
not a production fallback.

## Authorization

Any identity admitted by the configured Access policy may view, start, stop,
or request control of the fixed game slot. Narrow the policy to the intended
audience.

Each tab receives an opaque viewer capability bound to the Access principal.
The controller assignment names one viewer session. A run, viewer, SFU session,
track, DataChannel, URL, or slot identifier is not authorization.

The authenticated viewer heartbeat keeps both the viewer and its controller
assignment alive. If Access expires or heartbeats stop, the viewer expires,
input is released, and another tab may take control.

## Admission and abuse controls

Each admitted viewer creates Realtime SFU subscriber resources. Keep:

- A fixed per-slot viewer cap.
- Short viewer capabilities and heartbeat expiry.
- Same-origin mutation checks.
- A maximum run duration.
- Container idle shutdown when no viewer or controller remains active.

Add account-level rate limiting or narrower Access policies when exposing the
application to a larger audience.

## Publisher identity

The native publisher calls a virtual HTTP hostname intercepted by the Container
outbound Worker. The platform-provided container ID selects the originating
`GameContainer`.

Do not replace this with a shared bearer token in the image. The publisher
receives signaling results but never the Realtime SFU credential.

The current run ID and generation prevent a stale process from registering or
mutating a newer run.

## Container cost and limits

Starting the game creates a billable Container. The checked-in Wrangler
configuration permits one instance and the application also enforces one fixed
slot.

Review the instance type, maximum runtime, idle timeout, viewer cap, and Access
policy before hosting a public demo. Do not raise `max_instances` without a
matching per-identity creation quota and cleanup policy.

The Container filesystem is ephemeral. This blueprint does not persist game
state.

## Realtime SFU lifecycle

Every Realtime SFU session maps to one PeerConnection and one SDP state machine.
Serialize track and DataChannel mutations through required renegotiation.

Persist enough resource information to close:

- Publisher audio and video tracks.
- Viewer remote tracks.
- The publisher's two local input DataChannels.
- Each viewer's two remote input DataChannels.

Do not record or explicitly close the reserved `server-events` transport
channel. It belongs to the PeerConnection.

The public API does not expose a session-close operation. Close known tracks
and DataChannels, close each PeerConnection, and rely on inactivity collection
only for already unreachable residual session state.

Inspect every per-track and per-DataChannel result even when the top-level HTTP
response succeeds.

## Input safety

The Worker controls the accepted controller generation and uses
`datachannels/update` to grant or revoke `canReply` on both viewer
subscriptions. A DataChannel message cannot advance the generation.

The native publisher:

- Rejects stale, duplicated, malformed, oversized, and future-generation input.
- Bounds reliable input buffering.
- Coalesces or drops pointer movement under pressure.
- Releases every held key and button on generation change, viewer expiry,
  pointer-lock loss, process failure, and shutdown.

Keep the set of accepted keyboard and pointer events bounded to the application
being controlled.

## Failure behavior

A browser reconnect creates fresh viewer resources and never restores control
automatically.

The publisher retries only bounded failures where retrying cannot duplicate
application resources. Terminal signaling, media, WebRTC, or game-process
failure ends the run and starts cleanup.

The application records unfinished cleanup and retries it through the
`GameContainer` scheduler. Already absent resources are treated as successfully
cleaned. After confirmed Container shutdown and a bounded explicit-cleanup
window, a terminal run may rely on Realtime SFU inactivity expiry rather than
remaining permanently stuck in `stopping`.

## Multiple slots

Follow [Adapting to multiple slots](ARCHITECTURE.md#adapting-to-multiple-slots).
Do not raise `max_instances` or accept public slot names without authorization,
quotas, capability scoping, and cleanup.

## Observability

Log safe request and run correlation identifiers. Do not log Access assertions,
viewer or controller capabilities, Realtime SFU credentials, or full SDP.

At minimum, distinguish:

- Access denial.
- Container starting, ready, stopping, and failed states.
- Publisher registration and heartbeat expiry.
- Viewer negotiation failure.
- Controller claim, viewer expiry, and release.
- Realtime SFU track or DataChannel failure.
- Cleanup pending, retrying, and complete.
