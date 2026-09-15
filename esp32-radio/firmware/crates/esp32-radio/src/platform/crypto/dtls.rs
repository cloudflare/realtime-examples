use super::{ec, hashes::Hashes, signature::Verifier, suites};
use radio_webrtc::crypto::{
    CryptoError,
    dtls::{DtlsCert, DtlsInstance, DtlsProvider, DtlsVersion},
};
use std::time::Instant;

#[derive(Debug)]
pub(super) struct Provider;
impl DtlsProvider for Provider {
    fn generate_certificate(&self) -> Option<DtlsCert> {
        None
    }
    fn new_dtls(
        &self,
        cert: &DtlsCert,
        now: Instant,
        version: DtlsVersion,
        mtu: Option<usize>,
    ) -> Result<Box<dyn DtlsInstance>, CryptoError> {
        let mut crypto = dimpl::crypto::rust_crypto::default_provider();
        crypto.kx_groups = ec::GROUPS;
        crypto.key_provider = &ec::Keys;
        crypto.hash_provider = &Hashes;
        crypto.hmac_provider = &Hashes;
        crypto.signature_verification = &Verifier;
        suites::install(&mut crypto);
        str0m_rust_crypto::dtls_with_crypto_provider(cert, now, version, mtu, crypto)
    }
}
