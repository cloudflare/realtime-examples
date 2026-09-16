//! Low-priority sampling on core 1 refreshes idle accounting even while FFT sleeps.
use crate::{error::Result, platform};
use radio_core::metrics::{CpuWindow, Hardware};
use std::{
    sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    thread,
    time::Duration,
};

#[derive(Clone, Copy)]
pub(crate) struct Reading {
    pub hardware: Hardware,
    pub rssi: Option<i32>,
}
pub(crate) struct Client {
    receiver: Receiver<Reading>,
    latest: Option<Reading>,
}
pub(crate) struct Worker {
    sender: SyncSender<Reading>,
}

pub(crate) fn channel() -> (Client, Worker) {
    let (sender, receiver) = sync_channel(1);
    (
        Client {
            receiver,
            latest: None,
        },
        Worker { sender },
    )
}

impl Client {
    pub(crate) fn latest(&mut self, now_us: u64) -> Option<Reading> {
        if let Ok(reading) = self.receiver.try_recv() {
            self.latest = Some(reading);
        }
        self.latest.filter(|reading| {
            (now_us / 1000)
                .checked_sub(reading.hardware.sampled_at_ms)
                .is_some_and(|age| age <= 3000)
        })
    }
}

impl Worker {
    pub(crate) fn run(self) -> Result<()> {
        let mut native = platform::Metrics::open()?;
        let mut cpu = CpuWindow::default();
        let mut next_detailed = 0;
        let mut stack_free = 0;
        loop {
            let started = platform::now_us();
            let detailed = started >= next_detailed;
            let sample = native.sample(detailed)?;
            if detailed {
                stack_free = platform::stack_free();
                next_detailed = started + 5_000_000;
            }
            let hardware = Hardware {
                sampled_at_ms: sample.now_us / 1000,
                cpu_busy_bps: cpu.sample(sample.now_us, sample.idle_us),
                chip_temperature_mc: sample.temperature_mc,
                internal: sample.internal,
                psram: sample.psram,
                sample_cost_us: platform::now_us()
                    .saturating_sub(started)
                    .min(u32::MAX as u64) as u32,
                sampler_stack_free: stack_free,
            };
            match self.sender.try_send(Reading {
                hardware,
                rssi: sample.rssi,
            }) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => return Ok(()),
            }
            thread::sleep(Duration::from_micros(
                (started + 1_000_000).saturating_sub(platform::now_us()),
            ));
        }
    }
}
