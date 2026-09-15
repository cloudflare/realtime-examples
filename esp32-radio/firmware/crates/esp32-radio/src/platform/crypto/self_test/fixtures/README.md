# Public signature fixtures

The DER certificate and ECDSA signatures cover the fixed message
`Pocket Radio public crypto adapter test` using P-384 with SHA-256 and SHA-384.
They were generated with Python cryptography. The private key is not stored.

These public fixtures are included only with the `crypto-self-test` firmware
feature. They check valid signatures, altered messages/signatures, and malformed
certificates on the device.

The extended tests also use the existing public P-256 fixture in
`radio-webrtc/tests/fixtures/` to check native signing and verification.
That public test key is never used for the deployed radio's session identity.
