//! Streaming windowing and spectrum mapping. The caller supplies FFT storage
//! and runs the transform; this module contains no native code or allocation.
use crate::{music::BANDS, playback::Due};
use std::fmt;

pub const FFT_SIZE: usize = 2048;
pub const SAMPLE_RATE: u32 = 48_000;
pub const STEREO_SAMPLES: usize = 960 * 2;
pub const HISTORY_FLOATS: usize = FFT_SIZE * 2;
/// Maximum analysis age: 120 ms, or three nominal 25 Hz spectrum intervals.
pub const MAX_AGE_US: u64 = 120_000;

#[derive(Debug, Clone, Copy)]
pub struct Tag {
    pub due: Due,
    pub queued_us: u64,
}

impl Tag {
    pub fn is_fresh(self, epoch: u32, now_us: u64) -> bool {
        self.due.epoch == epoch && now_us >= self.queued_us && now_us - self.queued_us <= MAX_AGE_US
    }
}

/// Decoder/window continuity follows the transport timestamp and playback epoch.
#[derive(Debug, Default)]
pub struct Continuity {
    previous: Option<Due>,
}
impl Continuity {
    pub fn begin(&mut self, due: Due) -> bool {
        let reset = self.previous.is_none_or(|last| {
            last.epoch != due.epoch || last.pts_ms.wrapping_add(20) != due.pts_ms
        });
        self.previous = Some(due);
        reset
    }
    pub fn clear(&mut self) {
        self.previous = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidBuffer;
impl fmt::Display for InvalidBuffer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid analysis buffer size")
    }
}
impl std::error::Error for InvalidBuffer {}

/// Borrows caller-owned storage: one mono PCM ring and one periodic Hann window.
/// Debug output omits audio samples.
pub struct Window<'a> {
    storage: &'a mut [f32],
    position: usize,
    filled: usize,
    normalization: f32,
    ranges: [(usize, usize); BANDS],
}

impl fmt::Debug for Window<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Window")
            .field("filled", &self.filled)
            .field("fft_size", &FFT_SIZE)
            .finish_non_exhaustive()
    }
}

impl<'a> Window<'a> {
    pub fn new(storage: &'a mut [f32]) -> Result<Self, InvalidBuffer> {
        if storage.len() != HISTORY_FLOATS {
            return Err(InvalidBuffer);
        }
        storage.fill(0.0);
        let mut sum = 0.0;
        for (i, weight) in storage[FFT_SIZE..].iter_mut().enumerate() {
            *weight = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / FFT_SIZE as f32).cos();
            sum += *weight;
        }
        let ranges = std::array::from_fn(|band| {
            let low = 30.0 * (20_000.0_f32 / 30.0).powf(band as f32 / BANDS as f32);
            let high = 30.0 * (20_000.0_f32 / 30.0).powf((band + 1) as f32 / BANDS as f32);
            let scale = FFT_SIZE as f32 / SAMPLE_RATE as f32;
            let first = (low * scale).ceil() as usize;
            let end = (high * scale).ceil() as usize;
            if first == end {
                let nearest = (((low + high) * 0.5 * scale).round() as usize).max(1);
                (nearest, nearest + 1)
            } else {
                (first.max(1), end.min(FFT_SIZE / 2 + 1))
            }
        });
        Ok(Self {
            storage,
            position: 0,
            filled: 0,
            normalization: 4.0 / (sum * sum),
            ranges,
        })
    }

    pub fn clear(&mut self) {
        self.storage[..FFT_SIZE].fill(0.0);
        self.position = 0;
        self.filled = 0;
    }

    pub fn push_stereo(&mut self, pcm: &[i16]) -> Result<(), InvalidBuffer> {
        if pcm.len() % 2 != 0 {
            return Err(InvalidBuffer);
        }
        for sample in pcm.chunks_exact(2) {
            self.storage[self.position] =
                (i32::from(sample[0]) + i32::from(sample[1])) as f32 / 65536.0;
            self.position = (self.position + 1) % FFT_SIZE;
            self.filled = (self.filled + 1).min(FFT_SIZE);
        }
        Ok(())
    }

    /// Writes interleaved real/imaginary input in chronological order.
    pub fn write_complex(&self, out: &mut [f32]) -> Result<bool, InvalidBuffer> {
        if out.len() != FFT_SIZE * 2 {
            return Err(InvalidBuffer);
        }
        if self.filled < FFT_SIZE {
            return Ok(false);
        }
        for (i, pair) in out.chunks_exact_mut(2).enumerate() {
            pair[0] = self.storage[(self.position + i) % FFT_SIZE] * self.storage[FFT_SIZE + i];
            pair[1] = 0.0;
        }
        Ok(true)
    }

    /// Maps complex FFT bins in frequency order to 32 logarithmic bands.
    /// Encodes -72..-6 dBFS as 0..255, clamping values outside that range.
    pub fn bands(&self, transformed: &[f32]) -> Result<[u8; BANDS], InvalidBuffer> {
        if transformed.len() != FFT_SIZE * 2 {
            return Err(InvalidBuffer);
        }
        Ok(std::array::from_fn(|band| {
            let (first, end) = self.ranges[band];
            let power = (first..end)
                .map(|bin| {
                    let real = transformed[bin * 2];
                    let imag = transformed[bin * 2 + 1];
                    (real * real + imag * imag) * self.normalization
                })
                .fold(1e-12_f32, f32::max);
            ((10.0 * power.log10() + 72.0) * (255.0 / 66.0)).clamp(0.0, 255.0) as u8
        }))
    }
}
