# Native boundary contract

The private ABI is declared in `platform/include/radio_bridge.h` and imported
only by `esp32-radio/src/platform/ffi.rs`. Its functions pass fixed-width
integers, C strings, opaque handles, raw buffers and one private `#[repr(C)]`
HMAC scatter/gather pair. They never pass Rust-layout structs, trait objects,
owned Rust containers, enums or references. `size_t` corresponds to Rust
`usize`; both are 32-bit on this target.

All callers must provide valid pointer/length pairs, initialized inputs and
writable output storage of the declared capacity. Each Rust wrapper constructs
raw arguments from live slices or strings and checks returned lengths. Most C
outputs are bounded writes into caller-owned storage. HTTP and DSP expose
handle-tied buffer borrows; analysis history is a C allocation released through
its matching free function. The C header is private, not a general-purpose
public FFI library that accepts arbitrary hostile pointers.

## Ownership and calls

| Resource                                | Owner and lifetime                                                                                   | Synchronization                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Board drivers                           | One initialized board; C retains driver handles                                                      | Rust moves exclusive LED access to the radio task through a wrapper that is not `Sync`            |
| Crypto adapter keys and hash snapshots | Rust-owned bytes; adapter key and secret buffers use zeroizing storage | Synchronous native operations; shared ESP-IDF peripheral locks; no retained Rust pointers |
| DTLS certificate and private key | C generates with mbedTLS; Rust and str0m retain bounded DER buffers for the peer lifetime | Synchronous generation after Wi-Fi/time initialization; native contexts freed before return |
| Music partition and cache               | IDF owns the immutable partition descriptor; Rust owns a 32 KiB cache and a bounded offset index     | Synchronous C reads borrow writable Rust storage only for the call; the radio task owns the cache |
| HTTPS client/configuration/response     | C allocates; Rust owns the opaque handle and calls C cleanup in `Drop`                               | Client is neither `Send` nor `Sync`; blocking operations stay on signaling                        |
| HTTPS POST body                         | Borrowed for one blocking call                                                                       | Native POST field is replaced with a static empty body before return; callbacks write C-owned response storage |
| Decoder and aligned FFT buffer          | C owns config, PCM, packet and FFT storage; Rust holds a task-affine handle                          | Synchronous methods; no callbacks; one global ESP-DSP table owner                                 |
| Analysis history                        | C allocates initialized PSRAM; Rust exclusively borrows it for the window/ring                       | No C aliases; C frees after the Rust borrow ends                                                  |
| Task creation configuration             | Rust saves the creator's settings for new threads while configuring a task                           | A non-Send guard restores those settings on the creating task after the spawn attempt              |
| Metrics context and temperature sensor  | C owns a task-affine handle; Rust closes it on the same core-1 sampler task                          | Synchronous output copies into initialized Rust arrays; no callbacks or retained Rust pointers    |
| Recovery count in RTC memory            | C retains across software resets                                                                     | A C critical section protects updates; a Rust atomic selects the one task that initiates recovery  |

The HTTPS response is capped at 24,576 bytes, HTTP request bodies at 20,000 bytes,
SDP at 16,000 bytes, outbound data at 2,048 bytes, and individual Opus packets
at 1,275 bytes. Redirects are disabled. Time synchronization precedes verified
TLS, using the ESP-IDF certificate bundle. Credentials are compiled into the
private C configuration and never formatted into Rust errors.

## WebRTC ownership

WebRTC has no C peer handle or callbacks. `radio-webrtc` owns str0m, its UDP
socket and protocol queues entirely in Rust. The radio task passes UDP datagrams
and expired timers to str0m, writes audio and application data, and sends the UDP
packets that str0m returns. Certificate generation writes DER and used lengths
into caller-owned buffers, then frees its mbedTLS contexts before returning.
The host does not provision the live peer's certificate or key. Keys and SDP
must never enter logs.

## Crypto operations

AES and signature calls create native contexts locally, complete synchronously,
and free them before returning. The hardware APIs serialize peripheral access
with the same ESP-IDF locks used by HTTPS. Rust cipher, signing and key-exchange
instances contain only owned, zeroizing private bytes and public metadata; they
need no native pointer or unsafe `Send`/`Sync` implementation. For in-place GCM,
Rust derives both native buffer arguments from one exclusive pointer instead of
creating overlapping shared and mutable borrows.
Authentication failure clears the plaintext range before returning an error.

HMAC passes at most eight private C-layout pointer/length pairs, borrowed for
one call. Its SHA-1 interface and SHA-256 fingerprints can fall back to RustCrypto
on native failure. DTLS HMAC preserves the requested hash algorithm.

The 256-byte SHA snapshot stores a copy of the native context's value fields in
private opaque storage; it is not a public serialization format. For each
operation, C copies those bytes into an aligned local context. The pinned
ESP32-S3 SHA-256/SHA-512 contexts release their hardware locks between calls and
contain no heap pointer or persistent peripheral ownership. C initializes the
snapshot's unused bytes, checks its capacity at compile time, and finalizes a
copy so the stored state remains unchanged.
Review the native context fields and lock lifetime when upgrading ESP-IDF or
porting to another chip. A failed incremental hash aborts: its upstream trait
cannot return an error, and continuing would produce an invalid transcript.

EC verification parses only the supplied certificate's public key and checks
the signature. It is not CA-chain validation. The Rust adapter validates the
signature/hash/curve combination; str0m verifies the authenticated SDP fingerprint.

P-256 exchange exports a 32-byte private scalar and 65-byte uncompressed public
point to Rust-owned buffers. Completion validates the private scalar and remote
point before computing the secret, with RNG-backed blinding. Signing parses DER
into a temporary native context and returns a bounded DER signature. Wi-Fi starts
before these calls so ESP-IDF hardware entropy is available. No native EC context
survives a call. The adapter's signing-key copy, ECDH scalar and derived secret
use zeroizing storage; the DTLS layer releases its owned certificate and key
buffers with the peer.

## Failure and teardown

Release builds use `panic = "abort"`. Rust panics cannot unwind through C.
Expected input and transport failures use results/status codes; malformed
commands are rejected and counted without restarting the device.

A terminal recovery is a board restart after a task encounters a fatal runtime
error. A Rust atomic allows only the first failing task to initiate recovery;
other failing tasks wait for the restart. The initiator updates the persistent
recovery count and waits for a bounded backoff before restarting the board.

Dropping a str0m peer releases its Rust allocations and socket. For normal
protocol closure, call `close`, then continue processing str0m input and output
until it reports completion or the caller's deadline expires. No transport
callback can outlive the peer.

HTTP owns one 24 KiB response buffer in PSRAM. Its blocking post completes its
response callbacks before returning a read-only slice tied to `&mut Http`.
That borrow prevents another post or cleanup while the slice is used. Only
initialized response bytes are exposed. Native transport failures return a
negative status and an empty slice. Deserialization produces owned setup state
before reuse. C cleanup closes the client before freeing its configuration and
response buffer.

Analysis APIs exchange `float`/Rust `f32` and `int16_t`/Rust `i16` buffers.
The C build asserts 32-bit floats. PCM is exactly 960 stereo samples per packet;
FFT storage is 4,096 interleaved real/imaginary values for 2,048 points. Rust
buffer borrows exclude native decode/transform/cleanup calls. The decoder and
FFT have no asynchronous callbacks, so their `Drop` can close resources on the
owning task. ESP-DSP tables are global: the adapter permits only one owner and
no reinitialization after it is dropped. Keep FFT work out of interrupt context.

Metrics sampling writes three u64 microsecond counters (time since boot and
idle time on cores 0 and 1), six u32 memory values (free/minimum/largest for
internal RAM, then PSRAM), and two i32 sensor values (milli-Celsius and RSSI).
`INT32_MIN` marks an unavailable sensor. The wrapper supplies exactly those capacities.
The sampler's core affinity is checked before native temperature conversion;
its handle is neither `Send` nor `Sync`. Task creation uses ESP-IDF HAL's safe
pthread configuration API. A non-`Send` Rust guard saves the creator's settings
for new threads and restores them on the same task after spawning, including when
spawning fails. Missing settings or HAL's zero-priority error result fall back
to SDK defaults. Task names come from static Rust C-string literals;
configuration does not cross the private C ABI.
