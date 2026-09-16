//! Windowed scheduler accounting and measured hardware telemetry; no platform calls.
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub free: u32,
    pub minimum_free: u32,
    pub largest_block: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub sampled_at_ms: u64,
    pub cpu_busy_bps: [Option<u16>; 2],
    pub chip_temperature_mc: Option<i32>,
    pub internal: Memory,
    pub psram: Memory,
    pub sample_cost_us: u32,
    pub sampler_stack_free: u32,
}

/// Cumulative idle times are committed on task switches, so invalid deltas are
/// unavailable samples rather than a fabricated zero or saturated percentage.
#[derive(Debug, Default)]
pub struct CpuWindow {
    previous: Option<(u64, [u64; 2])>,
}

impl CpuWindow {
    pub fn sample(&mut self, now_us: u64, idle_us: [u64; 2]) -> [Option<u16>; 2] {
        let previous = self.previous.replace((now_us, idle_us));
        let Some((before_us, before_idle)) = previous else {
            return [None; 2];
        };
        let Some(elapsed) = now_us
            .checked_sub(before_us)
            .filter(|n| (100_000..=5_000_000).contains(n))
        else {
            return [None; 2];
        };
        std::array::from_fn(|core| {
            let idle = idle_us[core]
                .checked_sub(before_idle[core])
                .filter(|&n| n <= elapsed)?;
            Some(((elapsed - idle) * 10_000 / elapsed) as u16)
        })
    }
}
