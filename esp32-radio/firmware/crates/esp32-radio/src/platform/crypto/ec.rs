//! EC protocol traits with Rust-owned secret bytes and synchronous native calls.
use super::{hashes, native};
use dimpl::{
    CryptoError, CryptoOperation, HashAlgorithm, NamedGroup, SignatureAlgorithm,
    crypto::{ActiveKeyExchange, Buf, KeyProvider, SigningKey, SupportedKxGroup},
};
use zeroize::Zeroizing;

#[derive(Debug)]
pub(super) struct P256;
pub(super) static GROUPS: &[&dyn SupportedKxGroup] = &[&P256];

struct Exchange {
    secret: Zeroizing<[u8; 32]>,
    public: Buf,
}
impl std::fmt::Debug for Exchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("P256Exchange").finish_non_exhaustive()
    }
}
impl SupportedKxGroup for P256 {
    fn name(&self) -> NamedGroup {
        NamedGroup::Secp256r1
    }
    fn start_exchange(&self, mut public: Buf) -> Result<Box<dyn ActiveKeyExchange>, CryptoError> {
        let (secret, bytes) = native::p256_keygen()
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::StartKeyExchange))?;
        public.clear();
        public.extend_from_slice(&bytes);
        Ok(Box::new(Exchange { secret, public }))
    }
}
impl ActiveKeyExchange for Exchange {
    fn pub_key(&self) -> &[u8] {
        &self.public
    }
    fn group(&self) -> NamedGroup {
        NamedGroup::Secp256r1
    }
    fn complete(self: Box<Self>, peer: &[u8], out: &mut Buf) -> Result<(), CryptoError> {
        let peer: &[u8; 65] = peer
            .try_into()
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::CompleteKeyExchange))?;
        let value = native::p256_shared(&self.secret, peer)
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::CompleteKeyExchange))?;
        out.clear();
        out.extend_from_slice(value.as_ref());
        Ok(())
    }
}

#[derive(Debug)]
pub(super) struct Keys;
struct Signer {
    der: Zeroizing<Vec<u8>>,
    bits: i32,
}
impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EcSigningKey")
            .field("bits", &self.bits)
            .finish_non_exhaustive()
    }
}
impl KeyProvider for Keys {
    fn load_private_key(&self, der: &[u8]) -> Result<Box<dyn SigningKey>, CryptoError> {
        let bits = native::key_info(der)
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::LoadPrivateKey))?;
        Ok(Box::new(Signer {
            der: Zeroizing::new(der.to_vec()),
            bits,
        }))
    }
}
impl SigningKey for Signer {
    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
    fn hash_algorithm(&self) -> HashAlgorithm {
        if self.bits == 256 {
            HashAlgorithm::SHA256
        } else {
            HashAlgorithm::SHA384
        }
    }
    fn supported_hash_algorithms(&self) -> &[HashAlgorithm] {
        &[HashAlgorithm::SHA256, HashAlgorithm::SHA384]
    }
    fn sign(&mut self, data: &[u8], hash: HashAlgorithm, out: &mut Buf) -> Result<(), CryptoError> {
        let bits = hashes::bits(hash).ok_or(CryptoError::UnsupportedSignaturePair {
            signature: SignatureAlgorithm::ECDSA,
            hash,
        })?;
        let mut signature = [0; 128];
        let used = native::sign(&self.der, data, bits, &mut signature)
            .map_err(|_| CryptoError::OperationFailed(CryptoOperation::Sign))?;
        out.clear();
        out.extend_from_slice(&signature[..used]);
        Ok(())
    }
}
