use super::{hashes, native};
use dimpl::{
    CryptoError, HashAlgorithm, SignatureAlgorithm,
    crypto::{SignatureVerifier, cert_named_group, check_verify_scheme},
};

#[derive(Debug)]
pub(super) struct Verifier;
impl SignatureVerifier for Verifier {
    fn verify_signature(
        &self,
        cert: &[u8],
        data: &[u8],
        signature: &[u8],
        hash: HashAlgorithm,
        algorithm: SignatureAlgorithm,
    ) -> Result<(), CryptoError> {
        let group = cert_named_group(cert).map_err(|_| CryptoError::CertificateParseFailed)?;
        check_verify_scheme(algorithm, hash, group)?;
        let bits = hashes::bits(hash).ok_or(CryptoError::UnsupportedSignaturePair {
            signature: algorithm,
            hash,
        })?;
        native::verify_ec(cert, data, signature, bits).map_err(|_| {
            CryptoError::SignatureVerificationFailed {
                signature: algorithm,
                hash,
                group,
            }
        })
    }
}
