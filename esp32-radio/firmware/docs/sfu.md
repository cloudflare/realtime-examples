# How the firmware connects to Realtime SFU

Firmware owns a WebRTC peer, exchanges SDP through an application backend,
then sends Opus and DataChannels directly to Realtime SFU. This guide follows
that connection in Pocket Radio's Rust/str0m implementation on ESP32-S3, then
identifies the boundaries to adapt for your device or signaling server.

## Publisher setup

SFU API paths below are relative to
`https://rtc.live.cloudflare.com/v1/apps/{appId}`. Only the trusted backend
authenticates these requests with the SFU app token. `/api/device/*` paths are
this application's protocol, not SFU API endpoints.

1. **Create the local peer and offer.** After Wi-Fi and time initialization,
   firmware generates its DTLS certificate on the device. `Peer::open` binds a
   nonblocking IPv4 UDP socket, installs the certificate and crypto provider,
   adds a host candidate, and creates one send-only Opus media section. It also
   creates negotiated `server-events` on stream 0 to establish SCTP. The returned
   SDP offer and pending transition belong to this one peer.
2. **Ask the backend to publish.** The signaling task sends the offer, a fresh
   `bootId`, and music metadata to `/api/device/start`. The Worker authenticates
   the device; `RobotRoom` closes the previous generation's resources and calls
   `POST /sessions/new`, then `POST /sessions/{id}/tracks/new` with the offer and
   `{ location: "local", mid, trackName: "music" }`.
3. **Apply the answer on the peer's owner task.** The backend returns the SFU
   answer and an application generation. The signaling task validates the
   answer, sends `Request::Answer` to the radio task, and waits for its result.
   `Peer::answer` consumes the pending offer. No next setup mutation runs before
   that answer is applied successfully.
4. **Drive WebRTC until connected.** The radio loop processes UDP and timers.
   str0m handles ICE, DTLS, SRTP, SCTP, and channel state. The signaling task waits
   for the radio's connected event; it does not own or poll the peer itself.
5. **Allocate application channels.** `/api/device/channels` calls
   `POST /sessions/{id}/datachannels/new` with local `robot` and `spectrum`
   profiles. Firmware validates their names and distinct IDs, then passes those
   IDs to `Peer::create_channels`. These are externally negotiated channels;
   firmware does not send DCEP OPEN or invent stream IDs.
6. **Start publication and declare readiness.** The radio starts the playback
   loop. `/api/device/ready` makes the generation discoverable to listeners.
   Device heartbeats refresh liveness and current-song metadata; metadata
   updates also travel on `robot` to connected listeners.

A retry of startup reuses the same `bootId`, offer, and metadata. The backend
can return its existing answer instead of allocating another publisher. A new
boot gets a new identity. Generations stop delayed requests from modifying a
replacement session.

## Read the stack from the peer outward

| Source | What to follow |
| --- | --- |
| [radio-webrtc/connection.rs](../crates/radio-webrtc/src/connection.rs) | `Peer::open`, one pending offer, answer application, Opus and close |
| [radio-webrtc/network.rs](../crates/radio-webrtc/src/network.rs) | UDP input, timers, str0m output and connection events |
| [radio-webrtc/channels.rs](../crates/radio-webrtc/src/channels.rs) | Externally negotiated channels, reliability profiles and bounded queues |
| [radio-webrtc/audio.rs](../crates/radio-webrtc/src/audio.rs) | Encoded Opus into RTP with a continuous transport clock |
| [esp32-radio/radio.rs](../crates/esp32-radio/src/radio.rs) | Single peer owner, typed setup requests, media loop and commands |
| [esp32-radio/signaling.rs](../crates/esp32-radio/src/signaling.rs) | Application signaling, startup retries, generation and heartbeats |
| [radio-core/signaling.rs](../crates/radio-core/src/signaling.rs) | Bounded answer/channel values and recovery classification |
| [Worker RobotRoom](../../worker/src/server/robot-room.ts) | SFU operations and retained application/cleanup state |
| [Worker SfuClient](../../worker/src/server/sfu.ts) | HTTPS SFU calls, server-side token and allocation validation |

`radio-webrtc` has no ESP-IDF, HTTP, flash-playback, or hardware implementation.
It accepts an interface address, a fresh certificate, and a crypto provider
supplied through the device's platform adapters. The [firmware guide](../README.md)
and [native boundary](ffi.md) cover task, buffer, and hardware ownership.

## The WebRTC loop

The radio task exclusively owns `Peer`, its socket, media clock, playback, and
LED state. The HTTPS task exchanges typed requests/events with it. Analysis and
metrics run separately, so blocking server requests and FFT work do not own
the peer's execution loop.

The transport feeds accepted datagrams and expired timers to str0m, then drains
`poll_output` until the next timeout. Transmit outputs are sent over the same
UDP socket; protocol events update state or enqueue bounded commands. Every
protocol mutation drains output before another mutation. Keep that rule when
changing the scheduler or network adapter.

Audio input is an already encoded 20 ms stereo Opus frame. str0m writes RTP and
protects it with SRTP. The 48 kHz transport clock continues across pause, restart,
and track changes; a song position is not an RTP timestamp. This implementation
sends Opus silence while paused. A different media source must supply the codec
and timing negotiated by its peer.

`robot` is reliable and ordered for metadata, telemetry and commands. `spectrum`
is unordered with zero retransmits because a newer sample replaces an old one.
Outbound and reassembled inbound data have separate bounded queues. Receive
budgets, task stack placement, and crypto adapters are part of this constrained
device's design; preserve the [vendor patches](../../THIRD_PARTY.md) and
[integration notes](../../ERRATA.md) until an alternative is validated.

## A listener and the return path

The browser demonstrates the other endpoint without changing firmware's peer.
After application authentication, its backend creates a new SFU session and
uses `/datachannels/establish` to obtain an offer for that session. The browser
answers it; the backend submits `/renegotiate` and allocates remote `robot` and
`spectrum` channels pointing at the publisher session.

The browser installs the IDs returned for its own connection, waits for open,
and sends the `ack` required by `waitForAck: true`. Its IDs need not equal the
device's IDs: these are separate SCTP associations. The backend then pulls
`music` with `/tracks/new`; the browser applies that offer and returns an answer
through `/renegotiate` before completing setup.

Control permission is a backend decision. `RobotRoom` uses
`PUT /sessions/{viewerSessionId}/datachannels/update` to set `canReply` on the
remote `robot` channel for one leased controller. Its commands travel through
the SFU to the board, which validates and applies them on the radio task.
Release/expiry revokes permission before the next controller is admitted.
Spectrum remains a one-way publication.

## Replace device-to-server signaling

If you use CoAP for device signaling, your server still calls the SFU over
HTTPS. Media and DataChannels use WebRTC. This example implements HTTPS
signaling; a CoAP client and server ingress would be an adaptation.

The narrow replacement point is the client/endpoint adapter in
[signaling.rs](../crates/esp32-radio/src/signaling.rs) and its
[HTTP platform wrapper](../crates/esp32-radio/src/platform/http.rs), plus the
matching backend ingress. Keep the radio task's typed offer/answer/channel
exchange and ownership intact. The application need not copy these HTTP paths
or JSON envelopes, but its replacement must preserve their meaning:

| Application operation | Information and behavior to preserve |
| --- | --- |
| Start publisher | Authenticated device, bounded SDP offer, stable retry identity, validated answer and new generation |
| Install channels | Current generation, named reliability profiles, actual SFU-returned IDs, acknowledgment after the peer applies them |
| Ready | Announce usable media/data only after successful setup |
| Heartbeat | Current generation, liveness and revisioned application metadata |
| Failure/retry | Distinguish transient failure from stale/rejected state; retain allocation receipts and bound retries |

Transport acknowledgments alone do not prove that the peer applied an SDP
answer or installed channels. Preserve that application completion boundary.
Keep offers/answers intact within explicit size limits, correlate replies, and
handle duplicate or delayed messages without creating new sessions accidentally.
Authenticate the device-to-server channel and keep the SFU app token on the
trusted server regardless of the ingress protocol.

## Adapt to another SoC or design

Start from responsibilities rather than the board pinout:

- Preserve one peer/SDP owner, the SFU operation sequence, returned channel IDs,
  codec timing, controller authorization, and cleanup receipts.
- Replace platform Wi-Fi/network setup, clock/randomness, certificate/crypto
  integration, task scheduling, memory placement, and media I/O as the target
  requires. The current `radio-webrtc` component requires Rust `std` and UDP;
  host portability is not proof that another chip can run it unchanged.
- Keep DTLS fingerprint/signature verification and authenticated SRTP/SCTP
  processing. SDK-specific crypto locks and value snapshots must be reviewed
  for the new platform; do not copy their safety assumptions blindly.
- Choose memory/receive budgets for the new device, then exercise packet loss,
  control traffic, reconnect, and repeated teardown on that hardware.

Run the [declared checks](../../README.md#development) when adapting the stack.
The host [loopback tests](../crates/radio-webrtc/tests/loopback.rs) exercise real
UDP, DTLS and channels between host peers. Firmware/ABI/transport changes also
need the [target build](../README.md#build-and-test) and
[two-listener live test](../../worker/README.md#browser-tests); host and simulated
backend results do not establish hardware or live SFU behavior.
