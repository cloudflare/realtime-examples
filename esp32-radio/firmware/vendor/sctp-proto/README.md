# sctp-proto

Low-level protocol logic for the SCTP protocol

sctp-proto contains a fully deterministic implementation of SCTP protocol logic. It contains
no networking code and does not get any relevant timestamps from the operating system. Most
users may want to use the futures-based sctp-async API instead.

The main entry point is [Endpoint], which manages associations for a single socket. Use
[Endpoint::connect] to initiate outgoing associations, or provide a [ServerConfig] to
accept incoming ones. Incoming UDP datagrams are fed to [Endpoint::handle], which either
creates a new [Association] or returns an event to pass to an existing one.

[Association] holds the protocol state for a single SCTP association. It produces
[Event]s and outgoing packets via polling methods ([Association::poll],
[Association::poll_transmit]). Each association contains multiple [Stream]s for
reading and writing data.

[Endpoint]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Endpoint.html
[Endpoint::connect]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Endpoint.html#method.connect
[Endpoint::handle]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Endpoint.html#method.handle
[ServerConfig]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.ServerConfig.html
[Association]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Association.html
[Association::poll]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Association.html#method.poll
[Association::poll_transmit]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Association.html#method.poll_transmit
[Event]: https://docs.rs/sctp-proto/latest/sctp_proto/enum.Event.html
[Stream]: https://docs.rs/sctp-proto/latest/sctp_proto/struct.Stream.html

### Status

This crate is maintained by the [str0m] project, which has been using it since
January 2023. Other consumers include [ex_sctp] for Elixir WebRTC. The crate
is kept in sync with [rtc-sctp] where possible to share bug fixes.

Originally written by Rain Liu as a Sans-IO implementation of SCTP for the
webrtc-rs ecosystem, this crate predates `rtc-sctp` in the `webrtc-rs/rtc`
monorepo, which was later derived from this work. Maintenance was transferred
to the str0m maintainers in January 2026.

[str0m]: https://crates.io/crates/str0m
[ex_sctp]: https://github.com/elixir-webrtc/ex_sctp
[rtc-sctp]: https://github.com/webrtc-rs/rtc/tree/master/rtc-sctp

License: MIT/Apache-2.0

### Data-channel statistics

`Stream::stats()` returns cumulative `DataChannelStats` for one stream generation. Sent totals count
successful SCTP message acceptance; received totals count complete messages returned by `read` or
`read_sctp`. Fragmentation, retransmission, acknowledgements and partial consumption of the returned
`Chunks` do not add messages. `write_chunks` currently accepts the first non-empty buffer as one message
per call. DCEP and unknown PPIDs are excluded; empty-message PPIDs count one message and zero bytes
when sent with the RFC 8831 dummy byte. Text counts UTF-8 bytes. Counters saturate at `u64::MAX`.

For an embedding WebRTC report, map the four native counters to `messagesSent`, `bytesSent`,
`messagesReceived` and `bytesReceived`, and `stream_identifier` to `dataChannelIdentifier`.
For example, use an application-assigned association identity together with `generation` to allocate a
unique report `id`, supply `type = "data-channel"` and the report `timestamp`, and obtain `label`,
`protocol` and WebRTC `state` from the embedding channel. Convert message counters to WebIDL's `u32`
with an explicit overflow policy (for example, `u32::try_from(value).unwrap_or(u32::MAX)`).
Generation IDs never wrap: exhaustion prevents creation of another stream.

Drain `Association::poll()` after reads, close/reset operations and transport input, including after
association loss. `Event::DataChannelStatsFinal(snapshot)` transfers the final counters exactly once
when a stream generation is removed, after any retained messages have been drained or discarded.
Store that snapshot in the embedding report registry for the required closed-channel lifetime.
Reset completion and failure events retain their existing ordering; a reused stream ID has a new
generation and fresh counters. Poll final events before dropping the association.

These are SCTP boundary counters. If WebRTC buffers sends above SCTP or discards a read message before
firing its message event, the adapter must maintain counters at its actual API boundary; the native
receive count already includes that transport handoff. Peer-connection channel-open/close totals,
channel state and report retention belong to the embedding layer.
