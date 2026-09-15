# str0m transport patch

Source: crates.io `str0m` **0.23.1**, upstream revision
`120401c9affd97fd4246d9e7faf0ad4ca099c1bc` from
[algesten/str0m](https://github.com/algesten/str0m). This copy uses the MIT option;
`LICENSE-MIT.txt` preserves the upstream notice. `Cargo.toml.orig` is the published
original manifest; `transport.patch` records changes to published source and the
normalized manifest.

The firmware selects this copy through its workspace Cargo patch. It adds
`RtcConfig::set_sctp_receive_limits` and reexports `SctpReceiveLimits` from
`channel`. The policy configures ordinary client/server associations and SNAP,
and the same message size is advertised in SDP. Direct SNAP callers construct
matching `SctpInitData::with_receive_limits` before generating their INIT token.
The default behavior is unchanged when no policy is supplied.

SCTP transmit queues retain owned `Bytes` until DTLS accepts them, including
backpressure retries. This transfers packet ownership without a payload copy;
DTLS still borrows the packet for one synchronous call. Packet order,
retransmission and authentication behavior are unchanged. A direct `bytes`
dependency names the buffer type already used by sctp-proto.

The patch also keeps the upstream newer lint compatible with the supported
Rust 1.88 host compiler and makes the default SCTP constructor test-only.

## Source and tests

Production source, upstream library and integration tests, their original PCAP
fixtures, protocol documentation, manifests, changelog and license are preserved.
The vendor `.gitignore` explicitly re-includes the published PCAP inputs and BWE
diagram. Cargo registry metadata, the logo, README template, upstream CI, editor
and lint configuration, examples and example certificate-generation scaffolding
are omitted. The normalized manifest omits the removed example targets.

The local `Cargo.lock` pins the standalone host test graph; production uses the
firmware workspace lockfile. No firmware build depends on an archive, experiment,
registry-source modification or generated source copy.

From the `esp32-radio/` directory, run the full library suite with the local protocol
and provider patches:

```sh
cargo +1.88.0 test --manifest-path firmware/vendor/str0m/Cargo.toml \
  --locked --no-default-features --features rust-crypto --lib \
  --config 'patch.crates-io.sctp-proto.path="firmware/vendor/sctp-proto"' \
  --config 'patch.crates-io.str0m-rust-crypto.path="firmware/vendor/str0m-rust-crypto"' \
  --target-dir artifacts/vendor-tests
```

The upstream host tests generate certificates and therefore enable the provider's
`generate-cert` feature and its AWS-LC dependency. That feature is disabled in the
firmware graph. Keep these vendor crates excluded from workspace membership;
`--all-features` would select unrelated platform crypto providers.

`make check-transport-patches` also runs the retained `contiguous`, `keyframes`
and `loss` integration targets with `rust-crypto,_internal_test_exports`. Their
shared fixture loader covers all seven PCAP inputs, so CI checks that the
versioned copy contains those assets.

When upgrading, compare upstream first and remove equivalent local changes.
Run this suite, the sctp-proto suite, firmware checks, and live audio, spectrum,
command and reconnection validation. Receive budgets are defined in the
[sctp-proto patch](../sctp-proto/PATCH.md).
