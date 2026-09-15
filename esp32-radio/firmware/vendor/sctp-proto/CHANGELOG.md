# Unreleased

# 0.10.4

  * Bound FORWARD-TSN cumulative advance to avoid CPU exhaustion on large TSN jumps #56

# 0.10.3

  * Fix stream reset completion, failure reporting, and request serialization #54

# 0.10.2

  * Calculate message length accurately in the reassembly queue #50
  * Fix stream reset handshake and emit ResetComplete when complete #53

# 0.10.1

  * Add Association::is_closing() to expose SCTP shutdown-in-progress state #51

# 0.10.0

  * Report association loss separately from stream finish (breaking) #49
  * Fix cwnd computation panic for small MTU sizes #47
  * Bump rand 0.9.2 -> 0.9.4 to address RUSTSEC-2026-0097 #48

# 0.9.0

  * Add support for out of band negotiation for SNAP #34
  * Deduplicate incoming RE-CONFIG requests to prevent new stream destruction #30
  * Replace lazy_static with std::sync::LazyLock in tests #41
  * Preparation for no_std + alloc #36

# 0.8.1

  * Downgrade rand to 0.9 to avoid double chacha20 dep #39

# 0.8.0 (yanked)

  * Add I-FORWARD-TSN (RFC 8260) chunk support #29
  * MSRV 1.85, Edition 2024, bump deps #38
  * Enforce receive-side max message size #27

# 0.7.1

  * Fix server-side rwnd initialization from INIT #28

# 0.7.0

  * Mark some types non_exhaustive (breaking) #26
  * Sync sctp-proto with rtc-sctp (breaking) #25
  * Changes to adopt sctp-proto #24

# 0.6.0

  * Configurable SCTP retransmission limits and RTO values #22

# 0.5.0

  * Switch to maintained version of rustc-hash #21

# 0.4.0

  * Update rand crate to 0.9.1 #19
  * Clippy fixes #18
  * Update thiserror to 2.0.16 #17
  * Clippy fixes #16

# 0.3.0

  * Ignore unknown parameters (breaking) #14
  * Port CRC optimizations from webrtc-rs/sctp made by #13

# 0.2.2

  * Move per packet log from debug to trace #12

# 0.2.1

  * Don't log user initiated abort as err #11

# 0.2.0

  * Wrap around ssn to 0 and avoid panic #9
  * Clippy and rust analyzer warnings #10

# 0.1.7

  * Fix T3RTX timer starvation #7

# 0.1.6

  * Respond with ParamOutgoingResetRequest #6

# 0.1.5

  * Fix sequence_number.wrapping_add

# 0.1.4

  * Remove unused deps and update deps

# 0.1.3

  * Make API Sync (as well as Send) and write_with_ppi() #4
  * Chores (clippy and deps) #3
  * Configurable max_payload_size #2
  * Fix build #1
