# Rust firmware

Start with [How the firmware connects to Realtime SFU](docs/sfu.md) for the
peer loop, raw SFU API sequence, negotiated DataChannels, and the boundary
between device-to-server signaling and WebRTC. This guide describes the
ESP32-S3 implementation and its hardware/build details. Run Makefile commands
from the `esp32-radio/` blueprint directory.

The application uses Rust `std` on ESP-IDF. ESP-IDF supplies hardware drivers,
Wi-Fi, HTTPS and FreeRTOS; str0m supplies WebRTC with a combined ESP-IDF and
RustCrypto provider.
Rust's thread builder creates the tasks. `esp-idf-hal` configures pthread
priorities, core affinity and internal stacks for the radio, analysis and metrics
tasks, with a Rust guard that restores the creator's settings after each spawn.
The [native boundary contract](docs/ffi.md) defines their ownership rules.

## Modules

| Module                    | Responsibility                                                                   |
| ------------------------- | -------------------------------------------------------------------------------- |
| `radio-core::music`       | Validate catalogs and CRC; index and read packets from bounded storage           |
| `radio-core::playback`    | Advance song position and transport time against a supplied clock                |
| `radio-core::protocol`    | Parse commands and encode acknowledgments, telemetry and spectrum                |
| `radio-core::spectrum`    | Maintain PCM history, window samples, map FFT bins and validate result freshness |
| `radio-core::metrics`     | Calculate per-core busy time and format measured telemetry                        |
| `radio-core::now_playing` | Track current-song metadata, position and duration from emitted packets           |
| `radio-core::signaling`   | Validate Worker responses and identify fatal signaling failures                   |
| `radio-webrtc`            | Own str0m, UDP, timers, audio, negotiated data channels and bounded queues         |
| `esp32-radio::app`        | Create tasks and channels; coordinate one restart after fatal task errors          |
| `esp32-radio::radio`      | Own the peer, LED, playback state and packet buffers                             |
| `esp32-radio::signaling`  | Establish sessions and send HTTPS heartbeats                                     |
| `esp32-radio::analysis`   | Decode packet copies and calculate spectra on core 1                            |
| `esp32-radio::metrics`    | Sample CPU, chip temperature and memory on a low-priority core-1 task            |
| `esp32-radio::console`    | Handle local USB ping/reboot commands                                            |
| `esp32-radio::platform`   | Wrap ESP-IDF HAL and the private C ABI with safe Rust interfaces                  |
| `esp32-radio::platform::crypto` | Adapt ESP-IDF AES/SHA/EC and RustCrypto ChaCha to str0m/dimpl              |
| `platform/`               | Implement the C ABI for drivers, PSRAM, HTTPS, certificates, crypto and DSP      |

All three crates are application components with `publish = false`. `radio-core`
and `radio-webrtc` forbid unsafe code and run on desktop Rust without the ESP
SDK. The device crate builds as a static library for `xtensa-esp32s3-espidf`,
linked by CMake. CMake supplies its SDK configuration and include paths to
`esp-idf-sys`, which generates the bindings used by the HAL. Host checks compile
the device crate with a task-configuration stub that returns an error; they do
not run its tasks or compile the ESP-IDF-specific HAL code. The firmware build
compiles that code, and device checks validate its runtime behavior.

## Runtime

### Task ownership

The radio task exclusively owns the peer, LED, playlist position and counters.
It runs on core 0 at priority 5 with a 48 KiB internal stack. The signaling task
owns its blocking HTTPS client and a 16 KiB stack; it can run on either core.
They exchange typed requests and events through bounded channels. Each request
includes a separate channel for its acknowledgment.

### WebRTC transport

The [WebRTC loop](docs/sfu.md#the-webrtc-loop) describes input, timers, and the
required output drain after every protocol mutation. This port adds the
following memory and queue budgets.

Incoming text commands enter a queue of at most 16 messages, each at most 512
bytes. The radio consumes at most one command per iteration. Malformed commands
are rejected; queue overflow is counted in telemetry. Outgoing application data
is capped at 2 KiB per message with an 8 KiB buffered limit per channel.
Data-channel backpressure drops the attempted message and increments telemetry.
Other send failures return to the recovery path; audio-send failures end the
publisher session.
SCTP receive limits apply during reassembly: 8 KiB per message, 32 KiB of
retained DATA payload, 64 retained fragments and eight concurrently tracked
stream states. Stream IDs can still be large. These limits bound retained DATA
storage, not every SCTP control allocation. Exceeding a hard limit closes the
association; the resulting transport failure restarts the board and creates a
new session.

The str0m peer state is allocated on the heap so its construction and packet
loop stay within the radio task's stack budget. Catalog validation yields to the
scheduler between cache fills, which lets core 0's idle task service its
watchdog.
Allocations larger than 1 KiB prefer PSRAM; task stacks and the aligned FFT
buffer explicitly use internal RAM. Keep this threshold when changing SDK
configuration so transport buffers leave room for Wi-Fi and HTTPS.

### Cryptography

The board generates a fresh ECDSA P-256 key and self-signed certificate after
Wi-Fi and time synchronization. mbedTLS supplies certificate creation, AES-CTR,
AES-GCM, SHA/HMAC, P-256 key exchange and P-256/P-384 signing/verification.
RustCrypto supplies ChaCha20-Poly1305 and fallback primitives. str0m and dimpl
remain responsible for protocol processing, nonce construction, replay
protection and fingerprint checks.

The str0m crypto provider preserves upstream cipher-suite metadata and ordering,
with P-256 key exchange selected for this board. Native crypto calls use
ESP-IDF's shared peripheral locks and retain no Rust pointers. Adapter instances
store AES keys, signing-key copies, ECDH scalars and derived secrets in zeroizing
buffers. The DTLS certificate/key pair follows the owned buffer lifetimes defined
by str0m and dimpl. For incremental SHA, Rust stores a snapshot of the native
context's value fields instead of retaining a native handle.
See the [boundary contract](docs/ffi.md) for their SDK-specific requirements.

Startup checks cover GCM authentication failure, key derivation, multipart HMAC,
and SHA snapshots. dimpl also runs its configured provider validation. The small
[provider patch](vendor/str0m-rust-crypto/PATCH.md) supports application-supplied
certificates and crypto selection without enabling the AWS-LC generator.

### Data channels

Use the SFU-returned IDs and profiles described in
[publisher setup](docs/sfu.md#publisher-setup) and the
[listener return path](docs/sfu.md#a-listener-and-the-return-path).
The transport requires outbound IPv4 UDP; TURN and TCP fallback are not implemented.

### Audio and spectrum analysis

Audio scheduling uses absolute 20 ms deadlines and skips stale frames after a
stall. str0m's RTP writer creates an owned payload before returning, so the
radio can reuse the music buffer. Preserve the continuous
[transport clock](docs/sfu.md#the-webrtc-loop) across silence and track changes.

Pause freezes song position while sending Opus silence. Restarting the song
does not reset the transport clock. Spectrum is sent at 25 Hz, telemetry at
2 Hz. Network buffering makes the audio and graph approximately aligned.

The analysis task runs at priority 4 on core 1 with a 20 KiB internal stack.
It owns the Opus decoder and ESP-DSP floating-point FFT. The radio task runs on
the other core and sends packet copies through a bounded, nonblocking channel,
so it never waits for analysis work.

Rust owns the PCM ring, periodic Hann window, 32 logarithmic bands and result
timestamps; native adapters handle decoding and the 2,048-point FFT kernel.

PCM history lives in PSRAM, while the aligned FFT scratch buffer lives in
internal RAM. Each analysis job and result carries the current playback epoch.
Pause, resume, restart and track changes increment that epoch; the radio
discards any result whose epoch no longer matches. Missing packets reset decoder
and PCM-window continuity. Results delayed by more than 120 ms are also
discarded. During pause the radio sends zero bands without waiting for analysis.
Telemetry reports analysis timing and drop counts.

### Music and playback metadata

Music stays in a 16 MiB flash partition. Rust reads it through a 32 KiB cache
and indexes at most 180,000 packet offsets stored as 32-bit values. Every song's
metadata, record boundaries, and CRC are checked at boot. The
[music format](docs/music.md) describes v4 catalogs and older single-song packs.

The transport clock continues across automatic advancement and Next commands.
Automatic song changes commit at the next packet deadline; commands during the
final packet still act on the announced song.
A playback revision identifies one occurrence of a song within the current
publisher session. It changes on restart and whenever playback advances to
another song. Connected listeners receive the current metadata over the
reliable data channel. Device HTTPS heartbeats send the same metadata to the
Worker so listeners can see it before establishing WebRTC.

The shared `Station` stores the latest metadata in an immutable `Arc`. The
signaling task holds the mutex only long enough to clone that `Arc`, then
performs HTTPS after releasing the mutex. Metadata strings are copied only when
the radio publishes a new playback revision. HTTP response parsing borrows the
native client's single 24 KiB buffer; the parsed setup state owns its data before
the next request reuses that buffer.

## Hardware metrics

A priority-2 task on core 1 samples once per second with an 8 KiB internal stack.
It owns the chip temperature sensor; float conversion stays off the radio task.
CPU readings use per-core idle-time differences from ESP-IDF's 64-bit,
microsecond runtime counters. Waking the sampler also refreshes core 1's idle
accounting while analysis is paused. These readings describe non-idle scheduled
time, including the limitations of interrupt accounting; they are not power
measurements.

The sampler reports separate internal/PSRAM free bytes and refreshes minimum-free
and largest-block diagnostics every five seconds. Radio, analysis and sampler
stack readings report the lowest unused stack space since task creation. They
refresh every five seconds; analysis refreshes only while processing packets.
Temperature is measured inside the chip in the configured −10–80 °C range.
Unavailable temperature/RSSI values, initial CPU windows and invalid counter
deltas are `null`.

The radio reads a one-item metrics queue without waiting. If no sample is
available or the latest is more than three seconds old, `hardware` and `rssi`
are `null`. If the sampler exits with an error, readings become unavailable;
audio and controls continue.

The `hardware` telemetry object carries
`sampledAtMs` (boot-relative milliseconds), two `cpuBusyBps` values (0–10000),
`chipTemperatureMc` (milli-Celsius), `internal` and `psram` memory statistics,
`sampleCostUs` and `samplerStackFree`. Sampling cost is elapsed time including
preemption.

## Build and test

Complete the [root setup](../README.md#set-up), including the exported
`SIGNALING_URL`, then use the Makefile in `esp32-radio/`:

```sh
make tooling-check
make check-rust
make build-firmware
```

For extended on-device crypto tests, build with
`python3 scripts/build_firmware.py --crypto-self-test`, then flash and monitor.
This includes explicitly public test-key/signature fixtures, cross-library
P-256 signing and key agreement, negative verification, and buffer-boundary
cases before streaming. A normal build omits these fixtures.

For native AES/HMAC profiling, build with
`python3 scripts/build_firmware.py --crypto-profile`, then flash and run the image.
After five seconds of streaming, it measures calls and their mbedTLS allocation
requests for 30 seconds. It prints task-scoped aggregate counters over USB, with
no keys or payloads. These are requested allocations and elapsed call times, not
retained heap usage or CPU cycles. Normal builds omit the profiler and linker
wrappers.

C and header formatting follows [.clang-format](.clang-format) and covers
`platform/`. For editor formatting, use `.tools/clang-format/bin/clang-format`
from `esp32-radio/`; `make fmt-c` and CI use the same pinned 23.1.1
executable.

The helper uses `RADIO_SDK_ROOT` or a local SDK under `.tools/`. Output goes to
`<SDK root>/rust-radio-build`; private Wi-Fi/device headers are generated there.
Rust uses its release profile with `opt-level = "s"`. ESP-IDF and the C adapters
use `-O2`, with assertions enabled. The helper verifies these settings, the 1 KiB
PSRAM allocation threshold and native hardware crypto options before compilation.
Rust's release profile does not select C optimization.
Runtime accounting is enabled in `sdkconfig.defaults`. ESP-IDF keeps resolved
settings in generated `firmware/sdkconfig`; remove that file to reapply the
checked-in defaults when configuration changes.

Native revisions, patch provenance and tool versions live in
[scripts/project.py](../scripts/project.py), `Cargo.lock`, `dependencies.lock`
and the `vendor/*/PATCH.md` files. The Xtensa toolchain is named `esp-radio`.

The supported memory configuration and partition addresses are in
[sdkconfig.defaults](sdkconfig.defaults) and [partitions.csv](partitions.csv).
Keep those settings for the N32R16V. The native C adapters in `platform/` are
part of the Rust application's build.

See the root guide for [backup and flashing](../README.md#back-up-and-flash)
and [music replacement](../README.md#change-the-playlist). The board uses autonomous
HTTPS and exposes ping/reboot commands over USB.

For behavior or ABI changes, build for Xtensa and run the
[live browser test](../worker/README.md#browser-tests). Host tests use silence
and synthetic values; they cover parsing, playback, and analysis ordering but
cannot establish device timing, memory use, or Wi-Fi behavior. The transport
tests additionally exercise real UDP, DTLS, negotiated channels, packet loss,
and repeated teardown on the host.

Run `make check-transport-patches` after editing or upgrading the vendored
transport libraries. Their separate host test graph and patch provenance are
documented in [str0m](vendor/str0m/PATCH.md) and
[sctp-proto](vendor/sctp-proto/PATCH.md). CI runs both library suites and the
fixture-backed continuity, keyframe and packet-loss integration tests.

## Backup and flash details

Use the [README sequence](../README.md#back-up-and-flash) for the first flash.
Backup and flash helpers reset the board and interrupt listeners.

`make backup` reads and verifies the full 32 MiB flash, records its SHA-256, and
refuses to overwrite an existing backup. Files stay in
`artifacts/hardware-validation/`; use `RADIO_BACKUP_DIR` to select another
directory and keep separate backups for separate boards. `make backup-check`
verifies saved files without contacting the board.

Verified images are cached privately under `artifacts/flash-cache/`, keyed by
USB identity and partition layout. Later flashes write changed sectors and
verify the complete result; a stale baseline falls back to a full write.
Use `make flash FLASH_ARGS="--firmware-only --full"` for a complete firmware
write when troubleshooting. Plain `make flash` preserves the music partition.

`make monitor` streams filtered USB logs until interrupted.
`make monitor MONITOR_ARGS="--check --reset"` reboots and checks for a successful
heartbeat, exiting nonzero on failure. Reconnect browser listeners afterward.
