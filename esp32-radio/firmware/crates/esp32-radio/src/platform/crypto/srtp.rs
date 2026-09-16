use super::{key::Key, native};
use radio_webrtc::crypto::{
    AeadAes128GcmCipher, AeadAes256GcmCipher, Aes128CmSha1_80Cipher, CryptoError, SrtpProvider,
    SupportedAeadAes128Gcm, SupportedAeadAes256Gcm, SupportedAes128CmSha1_80,
};

#[derive(Debug)]
pub(super) struct Provider;
#[derive(Debug)]
struct Cipher(Key);

fn failed() -> CryptoError {
    CryptoError::Other("ESP-IDF AES operation failed".into())
}

impl Aes128CmSha1_80Cipher for Cipher {
    fn encrypt(&mut self, iv: &[u8; 16], input: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
        native::ctr(self.0.bytes(), iv, input, out).map_err(|_| failed())
    }
    fn decrypt(&mut self, iv: &[u8; 16], input: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
        Aes128CmSha1_80Cipher::encrypt(self, iv, input, out)
    }
}

impl Cipher {
    fn encrypt_gcm(
        &self,
        iv: &[u8; 12],
        aad: &[u8],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<(), CryptoError> {
        native::gcm(false, self.0.bytes(), iv, aad, input, out).map_err(|_| failed())
    }
    fn decrypt_gcm(
        &self,
        iv: &[u8; 12],
        aads: &[&[u8]],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<usize, CryptoError> {
        let clear = input.len().checked_sub(16).ok_or_else(failed)?;
        // SRTP may supply the header and rollover counter as separate AAD parts.
        let joined;
        let aad = if let [one] = aads {
            *one
        } else {
            joined = aads.concat();
            &joined
        };
        native::gcm(true, self.0.bytes(), iv, aad, input, out).map_err(|_| failed())?;
        Ok(clear)
    }
}
impl AeadAes128GcmCipher for Cipher {
    fn encrypt(
        &mut self,
        iv: &[u8; 12],
        aad: &[u8],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<(), CryptoError> {
        self.encrypt_gcm(iv, aad, input, out)
    }
    fn decrypt(
        &mut self,
        iv: &[u8; 12],
        aads: &[&[u8]],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<usize, CryptoError> {
        self.decrypt_gcm(iv, aads, input, out)
    }
}
impl AeadAes256GcmCipher for Cipher {
    fn encrypt(
        &mut self,
        iv: &[u8; 12],
        aad: &[u8],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<(), CryptoError> {
        self.encrypt_gcm(iv, aad, input, out)
    }
    fn decrypt(
        &mut self,
        iv: &[u8; 12],
        aads: &[&[u8]],
        input: &[u8],
        out: &mut [u8],
    ) -> Result<usize, CryptoError> {
        self.decrypt_gcm(iv, aads, input, out)
    }
}

impl SupportedAes128CmSha1_80 for Provider {
    fn create_cipher(&self, key: [u8; 16], _encrypt: bool) -> Box<dyn Aes128CmSha1_80Cipher> {
        Box::new(Cipher(Key::new(&key).expect("AES-128 key")))
    }
}
impl SupportedAeadAes128Gcm for Provider {
    fn create_cipher(&self, key: [u8; 16], _encrypt: bool) -> Box<dyn AeadAes128GcmCipher> {
        Box::new(Cipher(Key::new(&key).expect("AES-128 key")))
    }
}
impl SupportedAeadAes256Gcm for Provider {
    fn create_cipher(&self, key: [u8; 32], _encrypt: bool) -> Box<dyn AeadAes256GcmCipher> {
        Box::new(Cipher(Key::new(&key).expect("AES-256 key")))
    }
}

fn ecb_round(key: &[u8], input: &[u8], out: &mut [u8]) -> Result<(), ()> {
    // Match the upstream helper's two-block result, including PKCS#7 padding.
    let input: &[u8; 16] = input.try_into().map_err(|_| ())?;
    if out.len() < 32 {
        return Err(());
    }
    let mut first = [0; 16];
    let mut padding = [0; 16];
    native::ecb(key, input, &mut first)?;
    native::ecb(key, &[0x10; 16], &mut padding)?;
    out[..16].copy_from_slice(&first);
    out[16..32].copy_from_slice(&padding);
    Ok(())
}

impl SrtpProvider for Provider {
    fn aes_128_cm_sha1_80(&self) -> &'static dyn SupportedAes128CmSha1_80 {
        &Provider
    }
    fn aead_aes_128_gcm(&self) -> &'static dyn SupportedAeadAes128Gcm {
        &Provider
    }
    fn aead_aes_256_gcm(&self) -> &'static dyn SupportedAeadAes256Gcm {
        &Provider
    }
    fn srtp_aes_128_ecb_round(&self, key: &[u8], input: &[u8], out: &mut [u8]) {
        if ecb_round(key, input, out).is_err() {
            str0m_rust_crypto::default_provider()
                .srtp_provider
                .srtp_aes_128_ecb_round(key, input, out);
        }
    }
    fn srtp_aes_256_ecb_round(&self, key: &[u8], input: &[u8], out: &mut [u8]) {
        if ecb_round(key, input, out).is_err() {
            str0m_rust_crypto::default_provider()
                .srtp_provider
                .srtp_aes_256_ecb_round(key, input, out);
        }
    }
}
