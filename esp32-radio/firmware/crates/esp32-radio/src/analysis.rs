//! A core-1 task decodes queued copies of music packets. The radio never waits
//! for analysis: bounded queues and playback epochs discard obsolete work.
use crate::{
    error::{Error, Result},
    platform::{self, Dsp, History},
};
use radio_core::{
    music::{BANDS, MAX_OPUS_BYTES},
    playback::Due,
    protocol::SpectrumStatus,
    spectrum::{Continuity, Tag, Window},
};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};

struct Job {
    tag: Tag,
    length: usize,
    opus: [u8; MAX_OPUS_BYTES],
}
pub(crate) struct Output {
    pub tag: Tag,
    pub bands: [u8; BANDS],
    stats: SpectrumStatus,
}
pub(crate) struct Client {
    input: SyncSender<Job>,
    output: Receiver<Output>,
    stats: SpectrumStatus,
    input_dropped: u64,
    stale: u64,
}
pub(crate) struct Worker {
    input: Receiver<Job>,
    output: SyncSender<Output>,
}

pub(crate) fn channel() -> (Client, Worker) {
    let (input, worker_input) = sync_channel(4);
    let (worker_output, output) = sync_channel(2);
    (
        Client {
            input,
            output,
            stats: SpectrumStatus::default(),
            input_dropped: 0,
            stale: 0,
        },
        Worker {
            input: worker_input,
            output: worker_output,
        },
    )
}

impl Client {
    pub(crate) fn submit(&mut self, due: Due, opus: &[u8], now_us: u64) -> Result<()> {
        if opus.is_empty() || opus.len() > MAX_OPUS_BYTES {
            return Err(Error::new("invalid analysis packet size"));
        }
        let mut job = Job {
            tag: Tag {
                due,
                queued_us: now_us,
            },
            length: opus.len(),
            opus: [0; MAX_OPUS_BYTES],
        };
        job.opus[..opus.len()].copy_from_slice(opus);
        match self.input.try_send(job) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.input_dropped = self.input_dropped.saturating_add(1);
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => Err(Error::new("analysis task stopped")),
        }
    }
    pub(crate) fn latest(&mut self, epoch: u32, now_us: u64) -> Option<Output> {
        let mut latest = None;
        for _ in 0..2 {
            let Ok(output) = self.output.try_recv() else {
                break;
            };
            self.stats = output.stats;
            if output.tag.is_fresh(epoch, now_us) {
                latest = Some(output);
            } else {
                self.stale = self.stale.saturating_add(1);
            }
        }
        latest
    }
    pub(crate) fn status(&self) -> SpectrumStatus {
        SpectrumStatus {
            input_dropped: self.input_dropped,
            stale: self.stale.saturating_add(self.stats.stale),
            ..self.stats
        }
    }
}

impl Worker {
    pub(crate) fn run(self) -> Result<()> {
        let mut dsp = Dsp::open()?;
        let mut history = History::new()?;
        let mut window =
            Window::new(history.as_mut()).map_err(|_| Error::new("invalid FFT history"))?;
        let mut continuity = Continuity::default();
        let mut stats = SpectrumStatus::default();
        let mut total_us = 0u64;
        let mut consecutive_errors = 0;
        let mut next_stack_sample = 0;
        platform::log("Live spectrum ready: Rust analysis on core 1, 2048-point ESP-DSP FFT");
        while let Ok(job) = self.input.recv() {
            let now = platform::now_us();
            if !job.tag.is_fresh(job.tag.due.epoch, now) {
                stats.stale = stats.stale.saturating_add(1);
                continuity.clear();
                continue;
            }
            if continuity.begin(job.tag.due) {
                dsp.reset()?;
                window.clear();
                stats.resets = stats.resets.saturating_add(1);
            }
            let started = platform::now_us();
            match dsp.decode(&job.opus[..job.length]) {
                Ok(pcm) => {
                    window
                        .push_stereo(pcm)
                        .map_err(|_| Error::new("invalid PCM shape"))?;
                    consecutive_errors = 0;
                }
                Err(_) => {
                    stats.errors = stats.errors.saturating_add(1);
                    consecutive_errors += 1;
                    continuity.clear();
                    window.clear();
                    if consecutive_errors >= 10 {
                        return Err(Error::new("repeated Opus analysis failure"));
                    }
                    continue;
                }
            }
            stats.frames = stats.frames.saturating_add(1);
            let bands = if job.tag.due.spectrum
                && window
                    .write_complex(dsp.buffer_mut())
                    .map_err(|_| Error::new("invalid FFT input"))?
            {
                dsp.transform()?;
                Some(
                    window
                        .bands(dsp.buffer())
                        .map_err(|_| Error::new("invalid FFT output"))?,
                )
            } else {
                None
            };
            let elapsed = platform::now_us().saturating_sub(started);
            total_us = total_us.saturating_add(elapsed);
            stats.mean_us = (total_us / stats.frames).min(u32::MAX as u64) as u32;
            stats.max_us = stats.max_us.max(elapsed.min(u32::MAX as u64) as u32);
            if now >= next_stack_sample {
                stats.stack_free = platform::stack_free();
                next_stack_sample = now + 5_000_000;
            }
            if let Some(bands) = bands {
                match self.output.try_send(Output {
                    tag: job.tag,
                    bands,
                    stats,
                }) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        stats.output_dropped = stats.output_dropped.saturating_add(1)
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(Error::new("radio task stopped"));
                    }
                }
            }
        }
        Err(Error::new("analysis input closed"))
    }
}
