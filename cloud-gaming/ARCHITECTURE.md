# Cloud gaming architecture

This blueprint runs one Freedoom application in a Cloudflare Container. The
native publisher captures the application's X11 display and audio, sends media
through Cloudflare Realtime SFU, and injects authorized input received over two
Realtime SFU DataChannels.

![Cloud gaming architecture](architecture.svg)

The editable source is [`architecture.mmd`](architecture.mmd). Regenerate the
SVG with:

```bash
npm run diagram
```

## Responsibilities

### Browser

Cloudflare Access protects the application. Each browser tab creates a distinct
viewer session with one PeerConnection.

That PeerConnection:

- Receives H.264 video and Opus audio.
- Establishes one DataChannel transport using the server-offer,
  browser-answer, and renegotiation flow.
- Subscribes to the publisher's reliable and replaceable input channels.
- Acknowledges both subscriptions when they open.
- Sends input only while that tab owns the controller assignment.

Opening multiple tabs under one Access identity creates multiple viewers, not
multiple controllers.

### Worker

The Worker is the browser HTTP boundary. It validates request bodies, rejects
cross-origin mutations, verifies the Access assertion for every browser API,
and maps expected application outcomes to HTTP responses.

Realtime SFU credentials exist only in Worker secrets.

### GameContainer

`GameContainer` extends the public Cloudflare `Container` class, which is also a
Durable Object. One named instance owns:

- The run state and generation.
- Container start, stop, idle, and maximum-runtime behavior.
- Published media and DataChannel locators.
- Authenticated viewers, per-tab capabilities, and expiry.
- The selected viewer and trusted controller generation.
- Pending cleanup and retry state.

The front-door Worker calls ordinary application operations through typed
Durable Object RPC. Expected failures cross that boundary as serializable
tagged unions.

### Container publisher

The Container runs Xvfb, a private PulseAudio sink, Crispy Doom with Freedoom,
and the Rust publisher.

The publisher:

- Captures coherent X11 frames through MIT-SHM.
- Encodes and publishes H.264 video and Opus audio.
- Responds to WebRTC feedback such as keyframe requests.
- Creates one reliable input DataChannel and one replaceable pointer
  DataChannel for the run.
- Polls trusted application state for controller-generation changes.
- Validates bounded binary input frames and injects them through XTEST.
- Releases held input and closes local resources during every exit path.

The publisher does not receive Realtime SFU credentials. Its HTTP signaling
uses a virtual hostname intercepted by the Container outbound Worker. The
platform-provided container ID selects the originating `GameContainer`, and
the current run generation rejects stale processes.

## Media direction

The Container owns one publisher PeerConnection and Realtime SFU session. It
publishes one H.264 video track and one Opus audio track.

Each browser tab owns one Realtime SFU session and PeerConnection. The same
connection receives media and carries that viewer's two remote DataChannel
subscriptions.

Media does not pass through the Worker or Durable Object.

## Input direction

The publisher creates two fixed local DataChannels:

- A reliable ordered channel carries keyboard, buttons, wheel, ownership, and
  reset messages.
- An unordered channel with `maxRetransmits: 0` carries high-rate pointer
  movement.

Each viewer subscribes to both with the matching reliability settings,
`waitForAck: true`, and `canReply: false`. The browser sends one acknowledgment
on each channel as soon as it opens. The SFU consumes those first messages and
opens the delivery gates.

Taking control does not create another channel or PeerConnection. The
`GameContainer`:

1. Reserves the next controller generation for the requesting viewer.
2. Calls `datachannels/update` on both existing viewer subscriptions with
   `canReply: true`.
3. Marks the controller assignment active only after both updates succeed.

Realtime SFU permits one reply-capable subscriber for each publisher channel.
The application still keeps its own single-controller record so transport
permission is not treated as authorization.

The native publisher observes the active viewer and generation through trusted
HTTP polling, releases any held input from the previous generation, and sends
one reliable readiness message naming that viewer and generation. Every viewer
receives the message, but only the named viewer enables input.

Every binary input frame includes the controller generation and a sequence
number. Delayed or unauthorized messages are discarded even if transport
permission cleanup is still in progress.

## Authentication and authorization

Cloudflare Access authenticates the complete deployed application. The Worker
also verifies the Access JWT for every browser API.

Each viewer receives an opaque capability bound to its Access principal. This
distinguishes browser tabs under the same identity. The controller assignment
is bound to one viewer capability, not merely to the Access subject.

The fixed slot name, run ID, viewer ID, controller generation, Realtime SFU
session ID, track name, and DataChannel name do not grant permission.

## State and signaling

The `GameContainer` state is authoritative. Viewer and publisher heartbeats
bound abandoned state. Browser and publisher polling use monotonic run and
controller generations to converge after missed requests or temporary
disconnection.

Start first persists a generation-scoped `starting` run and returns
`202 Accepted`. Container instance and health-port readiness continue in the
background without holding the application mutation queue. The browser polls
status, which becomes **Running** only after the publisher registers its media
and input DataChannels. Stop cancels a pending launch. Startup has one
bounded Container-acquisition deadline followed by a two-minute publisher
readiness deadline. A late failure can affect only the generation that
requested it.

The status poll is the browser's source of truth for run state. Viewer
heartbeats renew viewer and controller liveness but do not return another copy
of the run snapshot.

Each Realtime SFU session has one PeerConnection and one SDP state machine.
Track and DataChannel mutations for that session remain serialized through any
required immediate renegotiation.

The browser DataChannel transport follows the same sequence as the adjacent
`echo-datachannels` example:

1. Call `datachannels/establish` without browser SDP.
2. Apply the returned SFU offer.
3. Create and apply the browser answer.
4. Send the answer to `renegotiate`.
5. Create the two remote application subscriptions.

The native publisher uses the same server-offer sequence before creating its
two fixed local application channels.

The reserved `server-events` transport channel belongs to the PeerConnection.
It is never added to the application cleanup ledger.

## Reconnect

A viewer transport failure releases local input, leaves the viewer, and creates
a fresh browser and SFU session. Control is not restored automatically.

The publisher retries only bounded, retryable signaling failures. A terminal
media, WebRTC, application, or signaling failure ends the run so resource
ownership remains legible.

## Cleanup

Normal release and shutdown:

1. Advance the trusted controller generation and release held input.
2. Revoke `canReply` from an active viewer when its session remains available.
3. Close each viewer's application DataChannels and media tracks when it
   leaves.
4. Close the publisher's application DataChannels and media tracks when the
   run ends.
5. Stop the application, publisher, and Container.
6. Clear persisted resource state after cleanup succeeds or record the
   remaining work for a scheduled retry.

Repeated cleanup treats already absent resources as success. Realtime SFU
inactivity collection is a final fallback. After the Container is confirmed
stopped, a terminal run abandons unreachable SFU resources only after a bounded
explicit-cleanup window so the application cannot remain stuck in `stopping`.
The application scheduler owns idle and maximum-runtime policy;
`Container.sleepAfter` remains a longer safety fallback.

## Adapting to multiple slots

The shipped Worker resolves one constant slot name and Wrangler sets
`max_instances: 1`. `GameContainer` does not otherwise rely on global singleton
state.

A multi-slot application would:

1. Accept a bounded slot identifier only on an Access-authenticated creation
   route.
2. Authorize and quota that identifier before passing it to `getContainer`.
3. Raise `max_instances` deliberately and document the billing consequence.
4. Put the slot identifier in viewer URLs and keep viewer capabilities scoped
   to that slot.
5. Add a separate index only when listing or discovery is an actual product
   requirement.

The blueprint does not implement these steps because a container-name input or
launch catalog would obscure the core media and control topology.

## Current limitations

See [Known limitations](README.md#known-limitations). The architecture
intentionally stops at one fixed game and one active controller.
