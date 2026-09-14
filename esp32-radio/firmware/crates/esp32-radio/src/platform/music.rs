//! One bounded read cache. Native reads copy synchronously into Rust-owned bytes.
use super::ffi;
use crate::error::{Error, Result};
use radio_core::music::{Error as ReadError, MAX_MUSIC_BYTES, ReadAt};

const CACHE_BYTES: usize = 32 * 1024;

pub(crate) struct MusicStorage {
    length: usize,
    cache: Vec<u8>,
    start: usize,
    used: usize,
    validating: bool,
    pub(crate) reads: u32,
    pub(crate) max_read_us: u32,
}

impl std::fmt::Debug for MusicStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MusicStorage")
            .field("length", &self.length)
            .field("cache_bytes", &self.cache.len())
            .field("reads", &self.reads)
            .field("max_read_us", &self.max_read_us)
            .finish_non_exhaustive()
    }
}

impl MusicStorage {
    pub(crate) fn open() -> Result<Self> {
        // SAFETY: IDF owns the immutable partition descriptor for the process lifetime.
        let length = unsafe { ffi::radio_music_size() };
        if length == 0 || length > MAX_MUSIC_BYTES {
            return Err(Error::new("music partition is missing or too large"));
        }
        Ok(Self {
            length,
            cache: vec![0; CACHE_BYTES],
            start: 0,
            used: 0,
            validating: true,
            reads: 0,
            max_read_us: 0,
        })
    }
    pub(crate) fn finish_validation(&mut self) {
        self.validating = false;
        self.reads = 0;
        self.max_read_us = 0;
    }
    pub(crate) fn cache_bytes(&self) -> usize {
        self.cache.len()
    }
}

impl ReadAt for MusicStorage {
    fn size(&self) -> usize {
        self.length
    }
    fn read_exact(&mut self, offset: usize, out: &mut [u8]) -> std::result::Result<(), ReadError> {
        if offset
            .checked_add(out.len())
            .is_none_or(|end| end > self.length)
        {
            return Err(ReadError::Truncated);
        }
        let mut cursor = offset;
        let mut copied = 0;
        while copied < out.len() {
            if cursor < self.start || cursor >= self.start + self.used {
                let start = cursor / CACHE_BYTES * CACHE_BYTES;
                let length = CACHE_BYTES.min(self.length - start);
                let began = super::now_us();
                // SAFETY: cache is initialized, exclusively borrowed and large enough.
                // The native function validates partition bounds, copies synchronously,
                // and retains no pointer. No flash writes occur while this reader lives.
                let result =
                    unsafe { ffi::radio_music_read(start, self.cache.as_mut_ptr(), length) };
                if result != 0 {
                    return Err(ReadError::Read);
                }
                self.reads = self.reads.saturating_add(1);
                self.max_read_us = self
                    .max_read_us
                    .max(super::now_us().saturating_sub(began).min(u32::MAX as u64) as u32);
                self.start = start;
                self.used = length;
                // Full-catalog CRC validation can keep core 0 busy for seconds.
                // Let its idle task run between cache fills; playback reads do
                // not take this extra sleep.
                if self.validating {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
            let within = cursor - self.start;
            let count = (self.used - within).min(out.len() - copied);
            out[copied..copied + count].copy_from_slice(&self.cache[within..within + count]);
            cursor += count;
            copied += count;
        }
        Ok(())
    }
}
