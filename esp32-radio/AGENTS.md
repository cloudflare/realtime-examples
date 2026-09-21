# Embedded WebRTC example

Start with [README.md](README.md). The main integration reference is
[firmware/docs/sfu.md](firmware/docs/sfu.md); ESP32, the playlist, and
HTTPS-to-Worker are the working implementation's choices. Run Makefile commands
from `esp32-radio/`.

Read the references for the component you change:

- Firmware: [firmware/AGENTS.md](firmware/AGENTS.md) and
  [firmware/README.md](firmware/README.md). Native ownership or crypto changes
  also require [ffi.md](firmware/docs/ffi.md).
- Browser or backend: [worker/AGENTS.md](worker/AGENTS.md) and
  [worker/README.md](worker/README.md). Authentication and lifecycle changes
  also require [ARCHITECTURE.md](ARCHITECTURE.md).
- Deployment or upgrades: [PRODUCTION.md](PRODUCTION.md) and the relevant
  compatibility notes in [ERRATA.md](ERRATA.md).

Keep public guidance focused on current behavior and reusable integration
boundaries. Keep measurements and session history in ignored `artifacts/`,
prototypes in `experiments/`, and downloaded tools in `.tools/`. Builds and CI
must use checked-in code and supported fixtures rather than local experiments.

## Security and lifecycle

- Realtime SFU credentials stay on the Worker. Firmware receives only device
  and Wi-Fi credentials plus the signaling origin. Keep private configuration,
  flash backups, firmware images, music, and generated Worker exports ignored.
- Preserve the viewer cookie, per-viewer token, device bearer token, and
  controller lease. Room labels and SFU identifiers are locators.
- Keep one PeerConnection and one SDP state machine per endpoint. Preserve
  sequential setup and answer application before the next SFU mutation. Keep
  Durable Object operations serialized across awaits, including cleanup and
  controller permission changes. Do not drop pending setup/cleanup work within
  the current generation.
- Preserve publisher generations, boot retry identity, allocation receipts,
  and cleanup retries within the current generation. Replacing or expiring the
  publisher retires that entire generation before new allocation, without
  waiting for SFU cleanup. Retirement does not prove forwarding or reply access
  has stopped; preserve the distinction in lifecycle guidance.
- Keep application channels on SFU-returned IDs: ordered reliable `robot`, and
  unordered zero-retransmit `spectrum`. Preserve stream-0 bootstrap and the
  browser's `waitForAck` acknowledgment before pulling audio.
- Keep RobotRoom's class name, persisted state, and migration history stable
  for compatible deployments. Preserve the firmware API and native ABI.

## Checks and adaptations

Use the [README check commands](README.md#development) with Node 24 and Rust
1.88.0; [blueprint.yaml](blueprint.yaml) declares the full suite. Repeat affected
checks when a change or failure justifies it.

Hardware, transport, crypto, or ABI changes require the build/live checks in
firmware/AGENTS.md. Describe interruptions before resetting or flashing the
target board, and preserve its verified backup. Distinguish host/fixture tests
from device evidence. The current firmware requires IPv4 UDP and the documented
S3 board; browsers rejoin manually. New ports and transports need their own
validation before documentation can claim support.
