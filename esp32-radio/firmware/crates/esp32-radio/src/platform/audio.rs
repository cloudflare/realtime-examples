//! Single-owner native decoding/FFT. All native buffers stay on the C allocator.
use super::ffi;
use crate::error::{Error, Result, check};
use radio_core::spectrum::{FFT_SIZE, HISTORY_FLOATS, STEREO_SAMPLES};
use std::{ffi::c_void, marker::PhantomData, ptr::NonNull, rc::Rc, slice};

#[derive(Debug)]
pub(crate) struct History {
    pointer: NonNull<f32>,
}
impl History {
    pub(crate) fn new() -> Result<Self> {
        // SAFETY: C transfers a fresh, zeroed and float-aligned 4096-value PSRAM
        // allocation. There are no native aliases or callbacks to its contents.
        let pointer = NonNull::new(unsafe { ffi::radio_analysis_history_alloc() })
            .ok_or(Error::new("analysis history allocation failed"))?;
        Ok(Self { pointer })
    }
    pub(crate) fn as_mut(&mut self) -> &mut [f32] {
        // SAFETY: exactly HISTORY_FLOATS initialized values in one allocation;
        // exclusive borrow tied to self prevents aliases and use after Drop.
        unsafe { slice::from_raw_parts_mut(self.pointer.as_ptr(), HISTORY_FLOATS) }
    }
}
impl Drop for History {
    fn drop(&mut self) {
        // SAFETY: all borrows ended; release on the same allocator that created it.
        unsafe { ffi::radio_analysis_history_free(self.pointer.as_ptr()) };
    }
}

/// Neither Send nor Sync: decoder, FFT and global DSP table lifetime share one task.
#[derive(Debug)]
pub(crate) struct Dsp {
    handle: NonNull<c_void>,
    fft: NonNull<f32>,
    _task: PhantomData<Rc<()>>,
}
impl Dsp {
    pub(crate) fn open() -> Result<Self> {
        // SAFETY: scalar query of current FreeRTOS task. Check affinity before
        // any Rust or native floating-point work can trigger lazy FPU pinning.
        if unsafe { ffi::radio_current_core() } != 1 {
            return Err(Error::new("analysis must run on core 1"));
        }
        // SAFETY: C enforces one DSP owner, retains configuration and allocates
        // all buffers before returning. It registers no asynchronous callbacks.
        let handle = NonNull::new(unsafe { ffi::radio_dsp_open() })
            .ok_or(Error::new("audio analysis initialization failed"))?;
        // SAFETY: a successfully opened context always contains its initialized,
        // aligned 4096-float FFT buffer, owned until radio_dsp_free.
        let fft = NonNull::new(unsafe { ffi::radio_dsp_fft_buffer(handle.as_ptr()) })
            .expect("native DSP buffer invariant");
        Ok(Self {
            handle,
            fft,
            _task: PhantomData,
        })
    }
    pub(crate) fn reset(&mut self) -> Result<()> {
        // SAFETY: same-task sole owner and no native callbacks or outstanding PCM borrow.
        let code = unsafe { ffi::radio_dsp_reset(self.handle.as_ptr()) };
        check(code, "Opus decoder reset failed")
    }
    pub(crate) fn decode(&mut self, opus: &[u8]) -> Result<&[i16]> {
        // SAFETY: C validates size and copies the packet into owned storage, then
        // synchronously decodes and verifies the exact PCM size/format.
        let code =
            unsafe { ffi::radio_dsp_decode(self.handle.as_ptr(), opus.as_ptr(), opus.len()) };
        check(code, "Opus decoding failed")?;
        // SAFETY: successful decoding initialized exactly STEREO_SAMPLES values.
        // Borrowing self prevents the next decode/reset/Drop while PCM is borrowed.
        let pcm = unsafe { ffi::radio_dsp_pcm(self.handle.as_ptr()) };
        // SAFETY: pcm is the live aligned native array described above, with no
        // native writes until another exclusive method call after this borrow ends.
        Ok(unsafe { slice::from_raw_parts(pcm, STEREO_SAMPLES) })
    }
    pub(crate) fn buffer_mut(&mut self) -> &mut [f32] {
        // SAFETY: exclusive borrow of a fully initialized C-owned array; there
        // are no asynchronous writers. It cannot coexist with transform or Drop.
        unsafe { slice::from_raw_parts_mut(self.fft.as_ptr(), FFT_SIZE * 2) }
    }
    pub(crate) fn buffer(&self) -> &[f32] {
        // SAFETY: same array as buffer_mut; self's shared borrow excludes mutation.
        unsafe { slice::from_raw_parts(self.fft.as_ptr(), FFT_SIZE * 2) }
    }
    pub(crate) fn transform(&mut self) -> Result<()> {
        // SAFETY: C transforms its own buffer synchronously, on its sole owning
        // task, after all Rust buffer borrows have ended. Global tables have one owner.
        let code = unsafe { ffi::radio_dsp_transform(self.handle.as_ptr()) };
        check(code, "FFT failed")
    }
}
impl Drop for Dsp {
    fn drop(&mut self) {
        // SAFETY: all synchronous operations and borrows ended; same task, sole
        // owner. C closes the decoder and DSP tables before freeing its buffers.
        unsafe { ffi::radio_dsp_free(self.handle.as_ptr()) };
    }
}
