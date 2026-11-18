# dimpl

dimpl — DTLS 1.2 and 1.3 implementation (Sans‑IO, Sync)

dimpl is a DTLS 1.2 and 1.3 implementation aimed at WebRTC. It is a Sans‑IO
state machine you embed into your own UDP/RTC event loop: you feed incoming
datagrams, poll for outgoing records or timers, and wire up certificate
verification and SRTP key export yourself.

## Goals
- **DTLS 1.2 and 1.3**: Implements the DTLS handshake and record layer used by WebRTC.
- **Safety**: `forbid(unsafe_code)` throughout the crate.
- **Minimal Rust‑only deps**: Uses small, well‑maintained Rust crypto crates.
- **Low overhead**: Tight control over allocations and buffers; Sans‑IO integration.

### Non‑goals
- **DTLS 1.0**
- **Async** (the crate is Sans‑IO and event‑loop agnostic)
- **no_std** (at least not without allocation)
- **RSA**
- **DHE**

### Version selection

Four constructors control which DTLS version is used:
- [`Dtls::new_12`][new_12] — explicit DTLS 1.2 (certificate‑based)
- [`Dtls::new_12_psk`][new_12_psk] — explicit DTLS 1.2 (PSK, no certificates)
- [`Dtls::new_13`][new_13] — explicit DTLS 1.3
- [`Dtls::new_auto`][new_auto] — auto‑sense: the first
  incoming ClientHello determines the version (based on the
  `supported_versions` extension)

## Cryptography surface
- **Cipher suites (TLS 1.2 over DTLS)**
  - `ECDHE_ECDSA_AES256_GCM_SHA384`
  - `ECDHE_ECDSA_AES128_GCM_SHA256`
  - `ECDHE_ECDSA_CHACHA20_POLY1305_SHA256`
- **PSK cipher suites (TLS 1.2 over DTLS)**
  - `PSK_AES128_CCM_8`
- **Cipher suites (TLS 1.3 over DTLS)**
  - `TLS_AES_128_GCM_SHA256`
  - `TLS_AES_256_GCM_SHA384`
  - `TLS_CHACHA20_POLY1305_SHA256`
- **AEAD**: AES‑GCM 128/256, ChaCha20‑Poly1305 (no CBC/EtM modes).
- **Key exchange**: ECDHE (P‑256/P‑384), X25519
- **Signatures**: ECDSA P‑256/SHA‑256, ECDSA P‑384/SHA‑384
- **DTLS‑SRTP**: Exports keying material for `SRTP_AEAD_AES_256_GCM`,
  `SRTP_AEAD_AES_128_GCM`, and `SRTP_AES128_CM_SHA1_80` ([RFC 5764], [RFC 7714]).
- **Extended Master Secret** ([RFC 7627]) is negotiated and enforced (DTLS 1.2).

### Certificate model
During the handshake the engine emits
[`Output::PeerCert`][peer_cert] with the peer's leaf
certificate (DER). The crate uses that certificate to verify DTLS
handshake messages, but it does not perform any PKI validation. Your
application is responsible for validating the peer certificate according to
your policy (fingerprint, chain building, name/EKU checks, pinning, etc.).

### Sans‑IO integration model
Drive the engine with three calls:
- [`Dtls::handle_packet`][handle_packet] — feed an entire
  received UDP datagram.
- [`Dtls::poll_output`][poll_output] — drain pending output:
  DTLS records, timers, events.
- [`Dtls::handle_timeout`][handle_timeout] — trigger
  retransmissions/time‑based progress.

The output is an [`Output`][output] enum with borrowed
references into your provided buffer:
- `Packet(&[u8])`: send on your UDP socket
- `BufferTooSmall { needed }`: resize the poll buffer and retry
- `Timeout(Instant)`: schedule a timer and call `handle_timeout` at/after it
- `Connected`: handshake complete
- `PeerCert(&[u8])`: peer leaf certificate (DER) — validate in your app
- `KeyingMaterial(KeyingMaterial, SrtpProfile)`: DTLS‑SRTP export
- `ApplicationData(&[u8])`: plaintext received from peer
- `CloseNotify`: peer sent a `close_notify` alert (graceful shutdown)

## Error handling

Every `Error` returned by the public API
([`handle_packet`][handle_packet], [`handle_timeout`][handle_timeout],
`send_application_data`, and `close`) is **fatal**: the connection is no
longer usable and must be thrown away. The engine has no recoverable
error states, so the correct response is always to drop the `Dtls`
instance — and start a fresh handshake if you still need a connection.

Transient, non‑fatal conditions inherent to running over an unreliable
transport — malformed datagrams, replayed or out‑of‑window records, and
other parser noise — are handled internally and never surface as an
`Error`. Such packets are discarded (logged at `debug!`) while the
connection keeps running. You therefore never need to distinguish
"retry" from "give up": a returned `Error` always means give up on this
connection.

## Example (Sans‑IO loop)

```rust
use std::sync::Arc;
use std::time::Instant;

use dimpl::{certificate, Config, Dtls, Output};

// Stub I/O to keep the example focused on the state machine
enum Event { Udp(Vec<u8>, Instant), Timer(Instant) }
fn wait_next_event(_next_wake: Option<Instant>) -> Event {
    Event::Udp(Vec::new(), Instant::now())
}
fn send_udp(_bytes: &[u8]) {}

fn example_event_loop(mut dtls: Dtls) -> Result<(), dimpl::Error> {
    let mut next_wake: Option<Instant> = None;
    let mut received_packet: Option<Vec<u8>> = None;
    loop {
        // Drain engine output until we have to wait for I/O or a timer
        let mut out_buf = vec![0u8; 2048];
        loop {
            match dtls.poll_output(&mut out_buf) {
                Output::Packet(p) => send_udp(p),
                Output::BufferTooSmall { needed } => {
                    out_buf.resize(needed, 0);
                }
                Output::Timeout(t) => { next_wake = Some(t); break; }
                Output::Connected => {
                    // DTLS established — application may start sending
                }
                Output::PeerCert(_der) => {
                    // Inspect peer leaf certificate if desired
                }
                Output::KeyingMaterial(_km, _profile) => {
                    // Provide to SRTP stack
                }
                Output::ApplicationData(_data) => {
                    // Deliver plaintext to application
                }
                Output::CloseNotify => {
                    // Peer initiated graceful shutdown — leave the event loop
                    return Ok(());
                }
                _ => {}
            }
        }

        if let Some(packet) = received_packet.take() {
            dtls.handle_packet(&packet)?;
            continue;
        }

        // Block waiting for either UDP input or the scheduled timeout
        match wait_next_event(next_wake) {
            Event::Udp(pkt, now) => {
                dtls.handle_timeout(now)?;
                received_packet = Some(pkt);
            }
            Event::Timer(now) => dtls.handle_timeout(now)?,
        }
    }
}

fn mk_dtls_client() -> Dtls {
    let cert = certificate::generate_self_signed_certificate().unwrap();
    let cfg = Arc::new(Config::default());
    let mut dtls = Dtls::new_12(cfg, cert, Instant::now());
    dtls.set_active(true); // client role
    dtls
}

// Putting it together
let dtls = mk_dtls_client();
let _ = example_event_loop(dtls);
```

## Example (PSK client)

```rust
use std::sync::Arc;
use std::time::Instant;

use dimpl::{Config, Dtls, PskResolver};

struct MyPsk;

impl PskResolver for MyPsk {
    fn resolve(&self, identity: &[u8]) -> Option<Vec<u8>> {
        if identity == b"device-01" {
            Some(b"shared-secret-key".to_vec())
        } else {
            None
        }
    }
}

let config = Arc::new(
    Config::builder()
        .with_psk_client(b"device-01".to_vec(), Arc::new(MyPsk))
        .build()
        .unwrap(),
);

let mut dtls = Dtls::new_12_psk(config, Instant::now());
dtls.set_active(true); // client role
```

#### MSRV
Rust 1.89.0

#### Status
- Session resumption is not implemented (WebRTC does a full handshake on ICE restart).
- Renegotiation is not implemented (WebRTC does full restart).

[new_12]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.new_12
[new_12_psk]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.new_12_psk
[new_13]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.new_13
[new_auto]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.new_auto
[peer_cert]: https://docs.rs/dimpl/latest/dimpl/enum.Output.html#variant.PeerCert
[handle_packet]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.handle_packet
[poll_output]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.poll_output
[handle_timeout]: https://docs.rs/dimpl/latest/dimpl/struct.Dtls.html#method.handle_timeout
[output]: https://docs.rs/dimpl/latest/dimpl/enum.Output.html
[RFC 5764]: https://www.rfc-editor.org/rfc/rfc5764
[RFC 7714]: https://www.rfc-editor.org/rfc/rfc7714
[RFC 7627]: https://www.rfc-editor.org/rfc/rfc7627


License: MIT OR Apache-2.0
