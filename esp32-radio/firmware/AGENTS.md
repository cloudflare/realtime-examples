# Firmware working agreements

This is a Rust application on ESP-IDF for the validated ESP32-S3 N32R16V.
Read README.md and docs/ffi.md before changing hardware ownership or transport.
Check ../ERRATA.md for known integration issues.

Keep portable behavior in radio-core and transport in radio-webrtc; both forbid
unsafe code. Keep C ABI calls and pointer handling inside
esp32-radio/src/platform, except the one
exported C entry point. Update both private ABI declarations together. Document
ownership, buffer retention, callback thread affinity and each unsafe block.

The radio task owns the peer, LED and playback state. HTTPS stays on its own
task. Native callbacks must not borrow Rust application state. Do not add unsafe
Send/Sync implementations. str0m and its UDP socket stay on the radio task;
fully drain poll_output after every protocol mutation.
Crypto adapters use ESP-IDF hardware locks and Rust-owned keys/value snapshots.
Review SHA context fields and lock release on SDK upgrades; preserve fingerprint,
signature and GCM authentication checks. Run the crypto-self-test image for
changes to these adapters before validating live audio and controls.

Retain octal flash/PSRAM settings and partition addresses for this board. Use
SFU-returned IDs for externally negotiated channels. Transport, crypto, task
affinity and buffering changes require live WebRTC checks, not only host tests.

Use make fmt-c for the C adapters; firmware/.clang-format defines their style.
Run make check from the root and make build-firmware for firmware changes.
Use meaningful behavioral tests for parsing, timing and recovery. Run the live
browser tests when changing device behavior or its native ABI. Hardware flashing
and tests interrupt current listeners; give a short progress update first.

Do not print credentials, SDP, private headers or firmware contents. Preserve
the verified original flash backup. Dependency revisions and patch provenance
live in scripts/project.py, Cargo.lock, dependencies.lock, and vendor/*/PATCH.md;
do not modify the downloaded vendor checkouts.
