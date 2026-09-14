//! Keys remain Rust-owned; native operations borrow them only during the call.
use zeroize::Zeroizing;

pub(super) struct Key {
    bytes: Zeroizing<[u8; 32]>,
    length: usize,
}
impl Key {
    pub(super) fn new(key: &[u8]) -> Option<Self> {
        if key.len() != 16 && key.len() != 32 {
            return None;
        }
        let mut bytes = Zeroizing::new([0; 32]);
        bytes[..key.len()].copy_from_slice(key);
        Some(Self {
            bytes,
            length: key.len(),
        })
    }
    pub(super) fn bytes(&self) -> &[u8] {
        &self.bytes[..self.length]
    }
}
impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AesKey").finish_non_exhaustive()
    }
}
