//! Synchronous mbedTLS calls. Native contexts live only inside C calls; SHA
//! snapshots contain values only, with their layout hidden from Rust.
use super::super::ffi;

pub(super) type Result<T> = std::result::Result<T, ()>;
fn check(code: i32) -> Result<()> {
    if code == 0 { Ok(()) } else { Err(()) }
}

pub(super) fn ctr(key: &[u8], iv: &[u8; 16], input: &[u8], output: &mut [u8]) -> Result<()> {
    // SAFETY: live, nonoverlapping slice storage; C validates capacities and key
    // size, finishes all hardware operations, and retains no pointer.
    check(unsafe {
        ffi::radio_crypto_aes_ctr(
            key.as_ptr(),
            key.len(),
            iv.as_ptr(),
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            output.len(),
        )
    })
}
pub(super) fn ecb(key: &[u8], input: &[u8; 16], output: &mut [u8; 16]) -> Result<()> {
    // SAFETY: exactly one block in/out, key is borrowed only during the call.
    check(unsafe {
        ffi::radio_crypto_aes_ecb(key.as_ptr(), key.len(), input.as_ptr(), output.as_mut_ptr())
    })
}
pub(super) fn gcm(
    decrypt: bool,
    key: &[u8],
    iv: &[u8; 12],
    aad: &[u8],
    input: &[u8],
    output: &mut [u8],
) -> Result<()> {
    // SAFETY: distinct live input/output slices; C checks all lengths and fully
    // authenticates before returning success. No pointers survive the call.
    check(unsafe {
        ffi::radio_crypto_aes_gcm(
            i32::from(decrypt),
            key.as_ptr(),
            key.len(),
            iv.as_ptr(),
            aad.as_ptr(),
            aad.len(),
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            output.len(),
        )
    })
}
pub(super) fn gcm_in_place(
    decrypt: bool,
    key: &[u8],
    iv: &[u8; 12],
    aad: &[u8],
    buffer: &mut [u8],
    input_length: usize,
) -> Result<()> {
    if input_length > buffer.len() {
        return Err(());
    }
    let capacity = buffer.len();
    let pointer = buffer.as_mut_ptr();
    // SAFETY: the one exclusive buffer owns both input and output. mbedTLS GCM
    // supports identical input/output addresses. Capacity includes encryption's
    // tag space; C validates lengths and clears plaintext on authentication failure.
    check(unsafe {
        ffi::radio_crypto_aes_gcm(
            i32::from(decrypt),
            key.as_ptr(),
            key.len(),
            iv.as_ptr(),
            aad.as_ptr(),
            aad.len(),
            pointer.cast_const(),
            input_length,
            pointer,
            capacity,
        )
    })
}
pub(super) fn sha256(input: &[u8]) -> Result<[u8; 32]> {
    let mut output = [0; 32];
    // SAFETY: caller-owned 32-byte output and a live, call-bounded input slice.
    check(unsafe { ffi::radio_crypto_sha256(input.as_ptr(), input.len(), output.as_mut_ptr()) })?;
    Ok(output)
}
pub(super) fn hmac(bits: i32, key: &[u8], parts: &[&[u8]], output: &mut [u8]) -> Result<()> {
    if parts.len() > 8 {
        return Err(());
    }
    let mut views = [ffi::CryptoPart {
        bytes: std::ptr::null(),
        length: 0,
    }; 8];
    for (view, bytes) in views.iter_mut().zip(parts) {
        *view = ffi::CryptoPart {
            bytes: bytes.as_ptr(),
            length: bytes.len(),
        };
    }
    // SAFETY: repr(C) views refer to input slices alive throughout this call;
    // only initialized views are counted. C owns/frees its context synchronously.
    check(unsafe {
        ffi::radio_crypto_hmac(
            bits,
            key.as_ptr(),
            key.len(),
            views.as_ptr(),
            parts.len(),
            output.as_mut_ptr(),
            output.len(),
        )
    })
}

pub(super) struct HashState(zeroize::Zeroizing<[u8; ffi::CRYPTO_HASH_STATE_BYTES]>);
impl HashState {
    pub(super) fn new(bits: i32) -> Result<Self> {
        let mut state = Self(zeroize::Zeroizing::new([0; ffi::CRYPTO_HASH_STATE_BYTES]));
        // SAFETY: C initializes all bytes of the fixed-capacity private snapshot.
        check(unsafe { ffi::radio_crypto_hash_init(state.0.as_mut_ptr(), bits) })?;
        Ok(state)
    }
    pub(super) fn update(&mut self, data: &[u8]) -> Result<()> {
        // SAFETY: snapshot comes only from successful C initialization/updates;
        // its storage is exclusive and C retains no pointer or hardware lock.
        check(unsafe {
            ffi::radio_crypto_hash_update(self.0.as_mut_ptr(), data.as_ptr(), data.len())
        })
    }
    pub(super) fn finish(&self, output: &mut [u8]) -> Result<()> {
        // SAFETY: C clones the pointer-free state before finalizing, leaving this
        // snapshot unchanged. The output slice accurately describes capacity.
        check(unsafe {
            ffi::radio_crypto_hash_finish(self.0.as_ptr(), output.as_mut_ptr(), output.len())
        })
    }
}

pub(super) fn verify_ec(cert: &[u8], data: &[u8], signature: &[u8], hash_bits: i32) -> Result<()> {
    // SAFETY: C validates all encodings/sizes, allocates and frees its temporary
    // certificate/key context, and retains no Rust input pointer.
    check(unsafe {
        ffi::radio_crypto_verify_ec(
            cert.as_ptr(),
            cert.len(),
            data.as_ptr(),
            data.len(),
            signature.as_ptr(),
            signature.len(),
            hash_bits,
        )
    })
}

pub(super) fn key_info(der: &[u8]) -> Result<i32> {
    let mut bits = 0;
    // SAFETY: C parses the borrowed DER into temporary native storage and writes
    // one initialized scalar. It retains no key bytes or pointers.
    check(unsafe { ffi::radio_crypto_key_info(der.as_ptr(), der.len(), &mut bits) })?;
    if bits != 256 && bits != 384 {
        return Err(());
    }
    Ok(bits)
}
pub(super) fn sign(der: &[u8], data: &[u8], bits: i32, out: &mut [u8; 128]) -> Result<usize> {
    let mut used = 0;
    // SAFETY: C borrows key/data, writes at most 128 signature bytes, and frees
    // its native key context before return. No callback enters Rust.
    check(unsafe {
        ffi::radio_crypto_sign(
            der.as_ptr(),
            der.len(),
            data.as_ptr(),
            data.len(),
            bits,
            out.as_mut_ptr(),
            out.len(),
            &mut used,
        )
    })?;
    if used == 0 || used > out.len() {
        return Err(());
    }
    Ok(used)
}
pub(super) fn p256_keygen() -> Result<(zeroize::Zeroizing<[u8; 32]>, [u8; 65])> {
    let mut secret = zeroize::Zeroizing::new([0; 32]);
    let mut public = [0; 65];
    // SAFETY: output arrays match the fixed ABI; C owns and frees its contexts.
    // Wi-Fi is started before constructing this provider, enabling hardware entropy.
    check(unsafe { ffi::radio_crypto_p256_keygen(secret.as_mut_ptr(), public.as_mut_ptr()) })?;
    Ok((secret, public))
}
pub(super) fn p256_shared(
    secret: &[u8; 32],
    public: &[u8; 65],
) -> Result<zeroize::Zeroizing<[u8; 32]>> {
    let mut value = zeroize::Zeroizing::new([0; 32]);
    // SAFETY: fixed-size inputs/outputs; C validates the scalar and remote point,
    // supplies blinding randomness and destroys all temporary MPI/EC allocations.
    check(unsafe {
        ffi::radio_crypto_p256_shared(secret.as_ptr(), public.as_ptr(), value.as_mut_ptr())
    })?;
    Ok(value)
}
