# Integration notes

Known issues and workarounds that matter when changing or upgrading the project.

## RustCrypto certificate generation

The upstream `str0m-rust-crypto` certificate generator pulls in AWS-LC, whose
native headers reject Xtensa. The firmware uses a small
[provider patch](firmware/vendor/str0m-rust-crypto/PATCH.md), disables that generator,
and supplies a fresh mbedTLS-generated certificate from the S3. Explicitly
select the configured crypto provider for DTLS; allowing default selection can
activate an unintended backend through Cargo feature unification.

Install only P-256 key exchange in the S3 provider before dimpl validates the
configured groups. Allowing its software P-384 exchange test can starve the idle
watchdog. Keep P-384 signature verification on mbedTLS; the corresponding
RustCrypto startup check also adds substantial startup time. Provider,
signature and fingerprint checks remain enabled.

## Crypto adapter boundaries

The SHA value-snapshot adapter is specific to the pinned S3 port, whose contexts
contain no pointers and release the peripheral lock between calls. Review both
properties before changing the SDK or target; checking struct size is insufficient.
In-place AES-GCM arguments must derive from the same exclusive Rust pointer.
Independent shared/mutable slice reborrows can violate Rust aliasing rules.

The native provider uses mbedTLS for both EC curves. In the pinned build,
hardware-assisted P-256 takes longer than software; using one EC backend is a
simplicity tradeoff. Recheck matching build options and full connection startup
before changing that policy. EC timings do not represent per-audio-packet costs.

Use `scripts/build_firmware.py --crypto-self-test` for adapter changes, then run
the image on the device and verify live audio/data. The extended tests include
altered signatures, malformed certificates and output bounds. Normal builds
omit their public signature fixtures.

## str0m task stack

Keep `Rtc` behind a `Box` in the transport. Storing and returning it inline
created large nested stack frames that overflowed a 48 KiB radio task during
initialization. Measure the low-water mark on the S3 after transport upgrades;
host compilation cannot establish the device stack requirement.

The radio task runs on core 0. Full-catalog validation must yield between
cache fills so that core's idle task can service its watchdog.

Keep the configured 1 KiB malloc threshold so larger allocations prefer PSRAM.
The SDK's 16 KiB setting filled internal RAM with transport allocations. Task
stacks, Wi-Fi and the FFT scratch buffer retain their internal memory.

## Negotiated data channels

See the [firmware/SFU walkthrough](firmware/docs/sfu.md) for channel setup and
profiles. Preserve these response-handling and memory constraints on upgrades.

The SFU can return only a channel's ID and name, without echoing `ordered` or
`maxRetransmits`. Normalize omitted settings from the shared channel profiles;
reject explicit settings that conflict with the requested reliability.

The command queue's 512-byte limit applies after SCTP reassembly. The local
str0m/sctp-proto patches enforce earlier receive budgets and align advertised
credit with retained DATA. Keep fragment, stream-state and byte bounds together;
an SDP message-size attribute alone cannot bound receive memory. Tests cover
fragmentation, TSN gaps, stream reset deferral and high negotiated IDs.

## N32R16V memory configuration

This board uses 32 MiB octal flash and 16 MiB octal PSRAM at 1.8 V. Retain its
OPI/DTR bootloader settings and partition layout. A generic S3 configuration
may not boot this module. Other ESP32 chips are not supported firmware targets.

## Rust and ESP-IDF linking

The build supplies `espidf_time64` for ESP-IDF 5's time ABI. The C adapter
component is linked with `WHOLE_ARCHIVE` so references introduced by the Rust
archive resolve correctly. The pinned Xtensa compiler does not support the
`compiler-builtins-weak-intrinsics` feature; leave it disabled.

The HAL uses the existing CMake SDK through `CARGO_CMAKE_BUILD_*` metadata.
The pinned bindings generator does not track those inputs for Cargo, so the
build fingerprints its SDK configuration and header context in Rust flags.
Configuration changes then regenerate the bindings instead of reusing stale ones.
Keep the HAL's `binstart` and `libstart` features disabled because `entry.c` owns
`app_main`. Binding generation uses libclang from the pinned `esp-radio`
toolchain; `make setup-firmware` supplies it. Host checks compile the application
with a stub that returns an error if task configuration is called. They do not
run the firmware or compile its HAL path; `make build-firmware` compiles that
path against the SDK, and device checks validate its behavior.

## Worker session cleanup and leases

Publisher retirement follows the
[lifecycle policy](ARCHITECTURE.md#cleanup-and-failure-behavior); old SFU cleanup
does not block a new boot. Current-generation cleanup and controller revocation
keep request-level failures pending, including HTTP 404/410 and top-level
`close_track_error`. Per-item absence must identify a requested resource.
Preserve the earliest alarm when polling status.

Persisted `pendingChannels` and `pendingMids` hold successful allocations from
partially failed SFU responses. They survive eviction within the current
generation until cleanup succeeds or the generation is retired. Before rolling
back to a version without receipt handling, close listeners and check cleanup
under the current version. Follow [shutdown](PRODUCTION.md#stop-and-clean-up)
before retirement discards those receipts.

## Music pack compatibility

Preparation creates a v4 playlist catalog for the 16 MiB music partition.
The firmware also reads v1/v2/v3 single-song packs. V4 contains bounded v3 song
packs; firmware limited to single-song formats cannot read it. When upgrading
an installation with a 4 MiB music partition, flash the partition table that
allocates 16 MiB to music together with the firmware before
using `make flash-music`. The helper checks the installed partition before writing.

The browser accepts 48-byte spectrum v2 packets, which include a playback
revision, and older 44-byte v1 packets. Deploy compatible Worker/browser code
before firmware changes that alter the protocol, and refresh open pages.

## Runtime metrics

CPU metrics require ESP-IDF's timer-backed U64 runtime counters. Idle runtime is
committed when a task switches out. Keep the sampler on core 1 so its wake-up
refreshes that core's counters during paused playback.

Temperature conversion uses floating point. Keep it on the pinned sampler task
to prevent ESP-IDF's lazy FPU handling from implicitly pinning the radio task.

The browser's telemetry schema accepts an optional `hardware` object. Missing
hardware measurements display as unavailable.
