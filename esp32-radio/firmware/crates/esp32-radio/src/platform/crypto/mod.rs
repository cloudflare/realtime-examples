//! ESP-IDF AES/SHA/EC with str0m/dimpl protocol code and RustCrypto ChaCha.
mod dtls;
mod ec;
mod hashes;
mod key;
mod native;
mod self_test;
mod signature;
mod srtp;
mod suites;

pub(crate) fn provider() -> radio_webrtc::CryptoProvider {
    self_test::run();
    super::log("Crypto: ESP-IDF AES/SHA/EC; RustCrypto ChaCha");
    radio_webrtc::CryptoProvider {
        srtp_provider: &srtp::Provider,
        sha1_hmac_provider: &hashes::Hashes,
        sha256_provider: &hashes::Hashes,
        dtls_provider: &dtls::Provider,
    }
}
