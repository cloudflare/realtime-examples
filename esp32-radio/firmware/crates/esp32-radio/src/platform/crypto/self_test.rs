//! Small public-vector startup checks for the private native boundary.
use super::{hashes::Hashes, native, srtp};
use dimpl::{
    HashAlgorithm,
    crypto::{Buf, HashProvider},
};
use radio_webrtc::crypto::SrtpProvider;

#[cfg(feature = "crypto-self-test")]
mod extended;

pub(super) fn run() {
    #[cfg(feature = "crypto-self-test")]
    extended::run();
    let reference = str0m_rust_crypto::default_provider();
    let iv = [0x13; 12];
    let aad = [0xab; 12];
    for length in [16, 32] {
        // Public synthetic keys and inputs; never used for a network session.
        let key = vec![0x42; length];
        let mut native_round = [0; 32];
        let mut reference_round = [0; 32];
        let mut block = [0; 16];
        native::ecb(&key, &[0; 16], &mut block).expect("native AES-ECB self-test");
        if length == 16 {
            srtp::Provider.srtp_aes_128_ecb_round(&key, &[0; 16], &mut native_round);
            reference
                .srtp_provider
                .srtp_aes_128_ecb_round(&key, &[0; 16], &mut reference_round);
        } else {
            srtp::Provider.srtp_aes_256_ecb_round(&key, &[0; 16], &mut native_round);
            reference
                .srtp_provider
                .srtp_aes_256_ecb_round(&key, &[0; 16], &mut reference_round);
        }
        assert!(
            native_round == reference_round && block == reference_round[..16],
            "AES-ECB self-test mismatch"
        );
        for n in [0, 1, 17, 1275] {
            let clear = vec![0x5a; n];
            let mut expected = vec![0; n + 16];
            if length == 16 {
                reference
                    .srtp_provider
                    .aead_aes_128_gcm()
                    .create_cipher(key[..].try_into().unwrap(), true)
                    .encrypt(&iv, &aad, &clear, &mut expected)
                    .expect("reference GCM");
            } else {
                reference
                    .srtp_provider
                    .aead_aes_256_gcm()
                    .create_cipher(key[..].try_into().unwrap(), true)
                    .encrypt(&iv, &aad, &clear, &mut expected)
                    .expect("reference GCM");
            }
            let mut buffer = clear.clone();
            buffer.resize(n + 16, 0);
            native::gcm_in_place(false, &key, &iv, &aad, &mut buffer, n)
                .expect("GCM encryption self-test");
            assert!(buffer == expected, "GCM encryption self-test mismatch");
            native::gcm_in_place(true, &key, &iv, &aad, &mut buffer, n + 16)
                .expect("GCM decryption self-test");
            assert!(buffer[..n] == clear, "GCM decryption self-test mismatch");
            buffer.copy_from_slice(&expected);
            buffer[n + 15] ^= 1;
            assert!(
                native::gcm_in_place(true, &key, &iv, &aad, &mut buffer, n + 16).is_err(),
                "GCM accepted a bad tag"
            );
            assert!(
                buffer[..n].iter().all(|byte| *byte == 0),
                "GCM retained unauthenticated plaintext"
            );
        }
    }
    for algorithm in [HashAlgorithm::SHA256, HashAlgorithm::SHA384] {
        let mut actual = Hashes.create_hash(algorithm);
        let mut expected = dimpl::crypto::rust_crypto::default_provider()
            .hash_provider
            .create_hash(algorithm);
        let mut a = Buf::new();
        let mut b = Buf::new();
        for part in [b"a".as_slice(), b"bc", &[0x5a; 1275]] {
            actual.update(part);
            expected.update(part);
            actual.clone_and_finalize(&mut a);
            expected.clone_and_finalize(&mut b);
            assert!(a[..] == b[..], "SHA snapshot self-test mismatch");
        }
    }
    let mut mac = [0; 20];
    native::hmac(160, b"public test key", &[b"a", b"bc"], &mut mac).expect("native HMAC self-test");
    assert!(
        mac == reference
            .sha1_hmac_provider
            .sha1_hmac(b"public test key", &[b"abc"]),
        "HMAC self-test mismatch"
    );
    super::super::log("Crypto boundary self-tests passed");
}
