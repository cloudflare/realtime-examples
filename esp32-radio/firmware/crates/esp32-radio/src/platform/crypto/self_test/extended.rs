//! Device-only signature, key-exchange and rejection checks for crypto-self-test.
use super::super::{ec, native, signature::Verifier};
use dimpl::{
    HashAlgorithm, SignatureAlgorithm,
    crypto::{Buf, KeyProvider, SignatureVerifier, SupportedKxGroup},
};
use std::{thread, time::Duration};

const CERT: &[u8] = include_bytes!("fixtures/p384.der");
const SHA256_SIG: &[u8] = include_bytes!("fixtures/p384-sha256.sig");
const SHA384_SIG: &[u8] = include_bytes!("fixtures/p384-sha384.sig");
const MESSAGE: &[u8] = b"Pocket Radio public crypto adapter test";
const P256_CERT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../radio-webrtc/tests/fixtures/certificate.der"
));
const P256_KEY: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../radio-webrtc/tests/fixtures/key.der"
));

pub(super) fn run() {
    let mut signer = ec::Keys
        .load_private_key(P256_KEY)
        .expect("native signing key test");
    for algorithm in [HashAlgorithm::SHA256, HashAlgorithm::SHA384] {
        let mut signature = Buf::new();
        signer
            .sign(MESSAGE, algorithm, &mut signature)
            .expect("native P-256 signing test");
        assert!(
            dimpl::crypto::rust_crypto::default_provider()
                .signature_verification
                .verify_signature(
                    P256_CERT,
                    MESSAGE,
                    &signature,
                    algorithm,
                    SignatureAlgorithm::ECDSA
                )
                .is_ok(),
            "native P-256 signature rejected by RustCrypto"
        );
        assert!(
            Verifier
                .verify_signature(
                    P256_CERT,
                    MESSAGE,
                    &signature,
                    algorithm,
                    SignatureAlgorithm::ECDSA
                )
                .is_ok(),
            "native P-256 signature rejected"
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert!(
        ec::Keys.load_private_key(&[]).is_err(),
        "empty private key accepted"
    );
    assert!(
        ec::Keys.load_private_key(&P256_KEY[..20]).is_err(),
        "truncated private key accepted"
    );
    let native = ec::P256
        .start_exchange(Buf::new())
        .expect("native ECDH setup test");
    let base = dimpl::crypto::rust_crypto::default_provider();
    let reference = base
        .kx_groups
        .iter()
        .find(|group| group.name() == dimpl::NamedGroup::Secp256r1)
        .unwrap()
        .start_exchange(Buf::new())
        .unwrap();
    let n_public = native.pub_key().to_vec();
    let r_public = reference.pub_key().to_vec();
    let mut n_secret = Buf::new();
    let mut r_secret = Buf::new();
    native
        .complete(&r_public, &mut n_secret)
        .expect("native ECDH completion test");
    reference.complete(&n_public, &mut r_secret).unwrap();
    assert!(
        n_secret[..] == r_secret[..],
        "native ECDH differs from RustCrypto"
    );
    let mut off_curve = [0; 65];
    off_curve[0] = 4; // Valid uncompressed encoding; (0, 0) is not on P-256.
    for (point, description) in [
        (&[0; 65][..], "invalid SEC1 encoding"),
        (&off_curve[..], "off-curve point"),
        (&n_public[..64], "truncated point"),
    ] {
        assert!(
            ec::P256
                .start_exchange(Buf::new())
                .unwrap()
                .complete(point, &mut Buf::new())
                .is_err(),
            "ECDH accepted {description}"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let valid_point = n_public.as_slice().try_into().unwrap();
    for scalar in [[0; 32], [0xff; 32]] {
        assert!(
            native::p256_shared(&scalar, valid_point).is_err(),
            "ECDH accepted out-of-range private scalar"
        );
    }
    for (hash, signature) in [
        (HashAlgorithm::SHA256, SHA256_SIG),
        (HashAlgorithm::SHA384, SHA384_SIG),
    ] {
        let result =
            Verifier.verify_signature(CERT, MESSAGE, signature, hash, SignatureAlgorithm::ECDSA);
        assert!(result.is_ok(), "P-384 valid signature rejected");
        thread::sleep(Duration::from_millis(1));
        assert!(
            Verifier
                .verify_signature(
                    CERT,
                    b"altered message",
                    signature,
                    hash,
                    SignatureAlgorithm::ECDSA
                )
                .is_err(),
            "P-384 altered message accepted"
        );
        thread::sleep(Duration::from_millis(1));
        let mut corrupt = signature.to_vec();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(
            Verifier
                .verify_signature(CERT, MESSAGE, &corrupt, hash, SignatureAlgorithm::ECDSA)
                .is_err(),
            "P-384 altered signature accepted"
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert!(
        Verifier
            .verify_signature(
                &CERT[..20],
                MESSAGE,
                SHA384_SIG,
                HashAlgorithm::SHA384,
                SignatureAlgorithm::ECDSA
            )
            .is_err(),
        "truncated certificate accepted"
    );
    assert!(
        native::verify_ec(&CERT[..20], MESSAGE, SHA384_SIG, 384).is_err(),
        "native truncated certificate accepted"
    );
    let mut out = [0xa5; 32];
    assert!(
        native::ctr(&[0; 15], &[0; 16], &[0; 16], &mut out).is_err(),
        "invalid AES key size accepted"
    );
    assert!(
        native::ctr(&[0; 16], &[0; 16], &[0; 33], &mut out).is_err(),
        "short CTR output accepted"
    );
    assert!(
        native::gcm(false, &[0; 16], &[0; 12], &[], &[0; 17], &mut out).is_err(),
        "short GCM output accepted"
    );
    assert!(
        native::gcm(true, &[0; 16], &[0; 12], &[], &[0; 15], &mut out).is_err(),
        "short GCM tag accepted"
    );
    crate::platform::log("Extended crypto security tests passed");
}
