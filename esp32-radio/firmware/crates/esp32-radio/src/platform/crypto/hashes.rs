use super::native;
use dimpl::{
    HashAlgorithm,
    crypto::{Buf, HashContext, HashProvider, HmacProvider},
};
use radio_webrtc::crypto::{Sha1HmacProvider, Sha256Provider};

#[derive(Debug)]
pub(super) struct Hashes;

pub(super) fn bits(algorithm: HashAlgorithm) -> Option<i32> {
    match algorithm {
        HashAlgorithm::SHA256 => Some(256),
        HashAlgorithm::SHA384 => Some(384),
        _ => None,
    }
}

impl Sha256Provider for Hashes {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        native::sha256(data).unwrap_or_else(|_| {
            str0m_rust_crypto::default_provider()
                .sha256_provider
                .sha256(data)
        })
    }
}
impl Sha1HmacProvider for Hashes {
    fn sha1_hmac(&self, key: &[u8], payloads: &[&[u8]]) -> [u8; 20] {
        let mut out = [0; 20];
        if native::hmac(160, key, payloads, &mut out).is_ok() {
            out
        } else {
            str0m_rust_crypto::default_provider()
                .sha1_hmac_provider
                .sha1_hmac(key, payloads)
        }
    }
}
impl HmacProvider for Hashes {
    fn hmac(
        &self,
        algorithm: HashAlgorithm,
        key: &[u8],
        data: &[u8],
        out: &mut [u8],
    ) -> Result<usize, dimpl::CryptoError> {
        if let Some(bits) = bits(algorithm)
            && native::hmac(bits, key, &[data], out).is_ok()
        {
            return Ok(bits as usize / 8);
        }
        dimpl::crypto::rust_crypto::default_provider()
            .hmac_provider
            .hmac(algorithm, key, data, out)
    }
}

struct Hash {
    state: native::HashState,
    length: usize,
}
impl std::fmt::Debug for Hash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EspHash").finish_non_exhaustive()
    }
}
impl HashProvider for Hashes {
    fn create_hash(&self, algorithm: HashAlgorithm) -> Box<dyn HashContext> {
        if let Some(bits) = bits(algorithm) {
            Box::new(Hash {
                state: native::HashState::new(bits).expect("SHA state initialization failed"),
                length: bits as usize / 8,
            })
        } else {
            dimpl::crypto::rust_crypto::default_provider()
                .hash_provider
                .create_hash(algorithm)
        }
    }
}
impl HashContext for Hash {
    fn update(&mut self, data: &[u8]) {
        // This upstream trait cannot return errors. A failed incremental hash
        // aborts the firmware rather than producing an invalid transcript.
        self.state.update(data).expect("SHA hardware update failed");
    }
    fn clone_and_finalize(&self, out: &mut Buf) {
        let mut digest = [0; 64];
        self.state
            .finish(&mut digest)
            .expect("SHA hardware finalization failed");
        out.clear();
        out.extend_from_slice(&digest[..self.length]);
    }
}
