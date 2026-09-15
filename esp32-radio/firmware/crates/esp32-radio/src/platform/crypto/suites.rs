//! Preserve upstream cipher metadata and ordering; replace AES operations only.
use super::{key::Key, native};
use dimpl::{
    CryptoError, CryptoOperation, HashAlgorithm,
    crypto::{
        Aad, Buf, Cipher, CryptoProvider, Dtls12CipherSuite, Dtls13CipherSuite, Nonce,
        SupportedDtls12CipherSuite, SupportedDtls13CipherSuite, TmpBuf,
    },
};
use std::sync::OnceLock;

#[derive(Debug)]
struct Gcm(Key);
fn cipher(key: &[u8], expected: usize) -> Result<Box<dyn Cipher>, CryptoError> {
    if key.len() != expected {
        return Err(CryptoError::OperationFailed(CryptoOperation::Encrypt));
    }
    let key = Key::new(key).ok_or(CryptoError::OperationFailed(CryptoOperation::Encrypt))?;
    Ok(Box::new(Gcm(key)))
}
impl Cipher for Gcm {
    fn encrypt(&mut self, data: &mut Buf, aad: Aad, nonce: Nonce) -> Result<(), CryptoError> {
        let length = data.len();
        if length > 16384 {
            return Err(CryptoError::OperationFailed(CryptoOperation::Encrypt));
        }
        data.resize(length + 16, 0);
        let iv: &[u8; 12] = nonce[..12]
            .try_into()
            .map_err(|_| CryptoError::InvalidNonce)?;
        if native::gcm_in_place(false, self.0.bytes(), iv, &aad, data, length).is_err() {
            data.clear();
            return Err(CryptoError::OperationFailed(CryptoOperation::Encrypt));
        }
        Ok(())
    }
    fn decrypt(&mut self, data: &mut TmpBuf, aad: Aad, nonce: Nonce) -> Result<(), CryptoError> {
        let length = data.len();
        let clear = length
            .checked_sub(16)
            .ok_or(CryptoError::OperationFailed(CryptoOperation::Decrypt))?;
        let iv: &[u8; 12] = nonce[..12]
            .try_into()
            .map_err(|_| CryptoError::InvalidNonce)?;
        native::gcm_in_place(true, self.0.bytes(), iv, &aad, data.as_mut(), length)
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::Decrypt))?;
        data.truncate(clear);
        Ok(())
    }
}

#[derive(Debug)]
struct Suite12(&'static dyn SupportedDtls12CipherSuite);
impl SupportedDtls12CipherSuite for Suite12 {
    fn suite(&self) -> Dtls12CipherSuite {
        self.0.suite()
    }
    fn hash_algorithm(&self) -> HashAlgorithm {
        self.0.hash_algorithm()
    }
    fn key_lengths(&self) -> (usize, usize, usize) {
        self.0.key_lengths()
    }
    fn explicit_nonce_len(&self) -> usize {
        self.0.explicit_nonce_len()
    }
    fn tag_len(&self) -> usize {
        self.0.tag_len()
    }
    fn min_protected_fragment_len(&self) -> usize {
        self.0.min_protected_fragment_len()
    }
    fn create_cipher(&self, key: &[u8]) -> Result<Box<dyn Cipher>, CryptoError> {
        match self.suite() {
            Dtls12CipherSuite::ECDHE_ECDSA_AES128_GCM_SHA256
            | Dtls12CipherSuite::ECDHE_ECDSA_AES256_GCM_SHA384 => {
                cipher(key, self.0.key_lengths().1)
            }
            _ => self.0.create_cipher(key),
        }
    }
}

#[derive(Debug)]
struct Suite13(&'static dyn SupportedDtls13CipherSuite);
impl Suite13 {
    fn aes(&self) -> bool {
        matches!(
            self.0.suite(),
            Dtls13CipherSuite::AES_128_GCM_SHA256 | Dtls13CipherSuite::AES_256_GCM_SHA384
        )
    }
}
impl SupportedDtls13CipherSuite for Suite13 {
    fn suite(&self) -> Dtls13CipherSuite {
        self.0.suite()
    }
    fn hash_algorithm(&self) -> HashAlgorithm {
        self.0.hash_algorithm()
    }
    fn key_len(&self) -> usize {
        self.0.key_len()
    }
    fn iv_len(&self) -> usize {
        self.0.iv_len()
    }
    fn tag_len(&self) -> usize {
        self.0.tag_len()
    }
    fn min_protected_fragment_len(&self) -> usize {
        self.0.min_protected_fragment_len()
    }
    fn create_cipher(&self, key: &[u8]) -> Result<Box<dyn Cipher>, CryptoError> {
        if self.aes() {
            cipher(key, self.0.key_len())
        } else {
            self.0.create_cipher(key)
        }
    }
    fn encrypt_sn(&self, key: &[u8], sample: &[u8; 16]) -> [u8; 16] {
        assert_eq!(key.len(), self.key_len(), "invalid DTLS record key length");
        let mut out = [0; 16];
        if self.aes() && native::ecb(key, sample, &mut out).is_ok() {
            out
        } else {
            self.0.encrypt_sn(key, sample)
        }
    }
}

pub(super) fn install(provider: &mut CryptoProvider) {
    // Upstream requires 'static factory references. These immutable descriptors
    // contain only references to upstream factories, never keys or session state.
    static VALUES12: OnceLock<Vec<Suite12>> = OnceLock::new();
    static REFS12: OnceLock<Vec<&'static dyn SupportedDtls12CipherSuite>> = OnceLock::new();
    static VALUES13: OnceLock<Vec<Suite13>> = OnceLock::new();
    static REFS13: OnceLock<Vec<&'static dyn SupportedDtls13CipherSuite>> = OnceLock::new();
    let values = VALUES12.get_or_init(|| {
        provider
            .cipher_suites
            .iter()
            .copied()
            .map(Suite12)
            .collect()
    });
    provider.cipher_suites = REFS12.get_or_init(|| {
        values
            .iter()
            .map(|v| v as &dyn SupportedDtls12CipherSuite)
            .collect()
    });
    let values = VALUES13.get_or_init(|| {
        provider
            .dtls13_cipher_suites
            .iter()
            .copied()
            .map(Suite13)
            .collect()
    });
    provider.dtls13_cipher_suites = REFS13.get_or_init(|| {
        values
            .iter()
            .map(|v| v as &dyn SupportedDtls13CipherSuite)
            .collect()
    });
}
