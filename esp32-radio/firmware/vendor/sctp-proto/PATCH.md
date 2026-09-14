# SCTP receive budgets and packet allocation

Source: crates.io `sctp-proto` **0.10.4**, upstream revision
`215565ad7aa80d3c160048350a2e6ddd8524920c` from
[algesten/sctp-proto](https://github.com/algesten/sctp-proto).
`LICENSE-MIT` and `LICENSE-APACHE` preserve the upstream notices.
`Cargo.toml.orig` is the published original manifest; `transport.patch` records
the source delta. The firmware workspace selects this copy through Cargo.

## Resource policy

`TransportConfig::with_receive_limits` accepts an optional `ReceiveLimits` policy
for message bytes, retained DATA bytes/fragments and live stream states. The
firmware uses 8 KiB per message, 32 KiB retained DATA, 64 fragments and eight live
stream states. Stream count is independent of numerical stream IDs, preserving
stream 0 and high IDs assigned by signaling. Later setters may lower the message
limit or receive window but cannot raise them beyond the policy.

The byte/fragment check runs before a new DATA chunk enters any receive queue.
It counts TSNs retained in the association payload queue, all complete/partial
stream reassembly queues and reset-deferred DATA. Shared TSNs are counted once.
A completed application read does not release credit for payloads still held
behind an earlier missing TSN. The advertised window reflects these retained
bytes and becomes zero when the fragment limit is reached.

Accepted payloads use one compact owned allocation, shared between receive
queues. A small slice cannot retain an unrelated large packet. Per-message size
checks remain in upstream reassembly. Stream state creation is also bounded.

Exceeding a hard limit returns an error through the existing association-close
path, releasing streams and emitting `AssociationLost`. A missing fragment that
would exceed the hard budget also closes the association; this intentionally
limits resources instead of allowing ordinary SCTP window overrun. Lost or
reordered packets within the budget retain normal delivery and credit recovery.
Callers reconnect after terminal closure.

These are bounds on retained DATA state, not all SCTP heap usage. Allocator and
container overhead, the current input packet, control/reset metadata and buffers
already returned to the caller are outside this accounting. Defaults preserve
upstream behavior when the policy is not set.

## Serialization and validation

Outgoing packet serialization reserves the known common header, chunk lengths
and padding in one allocation, using checked arithmetic. The existing serializer,
checksum, packet order and wire format are unchanged.

The source and upstream unit tests are preserved, including focused tests for
fragmentation, reset-deferred data, TSN gaps, high stream IDs, exhausted budgets,
compact payload ownership and terminal failure. Cargo registry metadata is omitted;
the local `Cargo.lock` pins standalone host tests. Production uses the firmware
workspace lockfile.

From the `esp32-radio/` directory:

```sh
cargo +1.88.0 test --manifest-path firmware/vendor/sctp-proto/Cargo.toml \
  --locked --lib --target-dir artifacts/vendor-tests
```

Keep this crate excluded from firmware workspace membership. On upgrades,
compare upstream and remove equivalent patch sections, then run these tests,
the str0m library suite, firmware checks and live WebRTC validation. No downloaded
registry or SDK source needs modification.
