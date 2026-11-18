# Unreleased

# 0.9.0

  * Update yanked crypto-bigint and remove unused cargo-deny licenses #206
  * Update deps to fix cargo-deny; bump MSRV to 1.89.0 (breaking) #205
  * Return slices from DTLS 1.2 cipher suite list methods (breaking) #204
  * Reject leftover handshake epochs in DTLS 1.2/1.3 #200
  * Discard premature ciphertext and stale plaintext handshakes #199
  * Drop unsupported epochs before buffering DTLS records #198
  * Drop duplicate DTLS 1.2 epoch-1 records queued before peer encryption #190

# 0.8.0

  * Preserve auto-client ClientHello offers across cookie retries #184
  * Ignore and ACK DTLS 1.3 post-handshake session tickets #182
  * ACK retransmitted DTLS 1.3 KeyUpdates after ACK loss #180
  * Complete DTLS 1.3 shutdown when answering the peer close_notify #181
  * Start handshake clocks at ClientHello and honor timing settings consistently #162
  * Update OpenSSL test dependency to resolve security advisories #176
  * Remove `HandshakePending`. All errors are fatal. (breaking) #175
  * Return accepted byte counts from `send_application_data` (breaking) #175
  * Parse DTLS 1.2/1.3 handshake payloads before committing transcript state #174
  * Accept DTLS 1.3 ACKs for earlier handshake and KeyUpdate transmissions #173

# 0.7.6

  * Reject empty required client certificates in DTLS 1.2 and 1.3 #170

# 0.7.5

  * Reject internally reordered DTLS 1.2 datagrams #169
  * Back off duplicate DTLS 1.2 flight resends #169
  * Restore DTLS buffer reuse and reject unpooled buffer returns #167

# 0.7.4

  * Preserve DTLS 1.3 client key shares on cookie-only retries #163

# 0.7.3

  * Fix DTLS 1.2 ClientHello retransmissions #160

# 0.7.2

  * Stop advertising unsupported RSA signatures in DTLS 1.2 CertificateRequest #157

# 0.7.1

  * Add `Dtls::is_closing()` and `Dtls::is_closed()` shutdown predicates #155

# 0.7.0

  * Omit empty DTLS 1.3 CertificateRequest certificate authorities #153
  * Fix DTLS handshake defragmentation across message sequences #151
  * Return `BufferTooSmall` instead of panicking on undersized poll buffers #150
  * Fix DTLS 1.3 RFC 9147 conformance issues #147
  * Reject malformed fragmented DTLS handshakes before consuming fragments #144
  * Represent DTLS wire-code identifiers as compact newtypes (breaking) #137
  * Make public errors structured and fatal-only (breaking) #134

# 0.6.2

  * Split local DTLS invalid-state errors from peer-input errors #126
  * Reject malformed DTLS 1.3 ClientHello extension vectors #133
  * Reject malformed DTLS 1.3 KeyUpdate bodies #131
  * Reject malformed DTLS 1.3 ACK record-number vectors #130
  * Parse DTLS 1.2-only ClientHellos for auto-sense fallback #129
  * Reject malformed DTLS 1.3 Cookie extension bodies #128
  * Reject oversized DTLS 1.2 CertificateRequest certificate authorities #127
  * Bound DTLS 1.3 ACK tracking during handshake replacement #120
  * Stop DTLS 1.2 flight resends once the peer handshake is confirmed #125
  * Drop plaintext DTLS 1.3 ACKs and alerts after peer encryption #118
  * Reject oversized DTLS extension vectors #119
  * Replace pending DTLS 1.2 handshake output on resend #116
  * Discard bad protected DTLS 1.2 records after handshake #115
  * Reject oversized DTLS certificate lists #113
  * Reject duplicate supported DTLS extensions #114
  * Reject malformed DTLS signature_algorithms vectors #111
  * Discard short DTLS 1.2 and 1.3 encrypted records #112
  * Drop late retransmitted DTLS 1.2 CCS after handshake #110

# 0.6.1

  * Fix auto-sense server falling back to DTLS 1.2 on non-ClientHello parse errors #106

# 0.6.0

  * Implement graceful shutdown #91
  * Add PSK (Pre-Shared Key) cipher suite `PSK_AES128_CCM_8` for DTLS 1.2 (breaking) #92
  * Fix DTLS 1.2 signature hash mismatch for P-384 keys #97

# 0.5.0

  * Remove PrfProvider/HkdfProvider, derive from HmacProvider (breaking) #94

# 0.4.3

  * Fix server auto-sensing DTLS version with fragmented ClientHello #87
  * DTLS 1.2 DTLS 1.3, parser reject ApplicationData in epoch 0/plaintext #90
  * DTLS 1.3 reject plaintext records with non-zero epoch #90
  * Silently discard invalid records and process subsequent valid records #90

# 0.4.2

  * Downgrade rand to 0.9 to avoid double chacha20 dep #84

# 0.4.1 (yanked)

  * Edition 2024 and bump deps (big cargo fmt) #83
  * Add DTLS 1.2 ChaCha20 and X25519 support #77
  * Bump MSRV to 1.85.0 #75
  * Make cipher and kx configurable #73

# 0.4.0

  * Restrict DTLS 1.2 key exchange to P-256/P-384 (for now) #70
  * Add AEAD, encrypt_sn, and key exchange validation to CryptoProvider #68
  * Add #[non_exhaustive] to public API enums likely to grow (breaking) #69
  * feat: Add protocol_version() accessor to Dtls #59
  * Bump all deps (possible with the current MSRV) #67
  * DTLS1.3 chacha20poly1305 and x25519 support #64
  * Fix panic in auto DTLS version selection #65
  * Add `Error::HandshakePending` for auto-sense pending state (breaking) #65
  * DTLS 1.2 ECDSA determine curve from certificate, not hash algorithm #57
  * DTLS 1.3 enforce SignatureScheme curve matches certificate key #60

# 0.3.0

  * DTLS 1.3 (breaking) #53
  * Refactor all/known/supported() (breaking) #55
  * Require now: Instant in Dtls::new() instead of panicking #54

# 0.2.7

  * Ensure compiling without features pulls in no deps #52

# 0.2.6

  * Fix ClientHello parser failing due to incorrect is_known method logic

# 0.2.5

  * Fix ClientHello Parser Failing when too many Cipher Suites #46

# 0.2.4

  * Drop dupe handshakes to not block newer messages #44

# 0.2.3

  * Fix DTLS HelloVerifyRequest by clearing queue_rx after sending HVR #40
  * Configurable RNG seed for tests #41

# 0.2.2

  * Add debug warn! for ReceiveQueueFull error #39

# 0.2.1

  * Fix DTLS protocol version in HelloVerifyRequest #36
  * Handle multiple Handshake in one Record #36
  * dimpl is not compatible with aws-lc-rs < 1.14 #35

# 0.2.0

  * Add fuzz testing to #32
  * Re-export Aad and Nonce that was missing #30
  * Add CodeQL analysis workflow configuration #27
  * Constant time equality #26
  * Pluggable CryptoProvider #16
    * aws-lc-rs backend (default)
    * rust-crypto backend (pure Rust)

# 0.1.5

  * Optimize parse speed using Box #14
  * Replace self_cell with indexes #14
  * Fix bug not retuning pooled Buf #14
  * Replace tinyvec with arrayvec #14
  * Remove zeroize - for now #13

# 0.1.4

  * Replace RustCrypto with aws-lc-rs #12
  * Fix SRTP key to include client_random and server_random #11
  * Make generated certs compatible with Firefox #11

# 0.1.3

  * Fixes to extension parsing #10
  * Better connection/flight timers #9
  * Remove rcgen/ring dependency #8

# 0.1.2

  * Bump MSRV to 1.81.0 #7
  * Bump rand to 0.9.x #7

# 0.1.1

  * Remove Diffie-Hellman (since no RSA) #6
  * Add github actions as CI #5
  * Fix bad MTU packing causing flaky tests #4
  * Remove ciphers using RSA #3

# 0.1.0
  * First published version
