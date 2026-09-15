//! Opt-in aggregate profiling; no packet or key material enters the counters.
use super::ffi;
use crate::error::{Result, check};

#[derive(Default)]
enum State {
    #[default]
    Waiting,
    Warmup(u64),
    Measuring(u64),
    Complete,
}

#[derive(Default)]
pub(crate) struct CryptoProfile(State);

impl CryptoProfile {
    /// Called only by the radio task while its connected playback loop runs.
    pub(crate) fn tick(&mut self, now_us: u64) -> Result<()> {
        match self.0 {
            State::Waiting => self.0 = State::Warmup(now_us + 5_000_000),
            State::Warmup(deadline) if now_us >= deadline => {
                // SAFETY: the caller is the sole radio owner, outside a crypto
                // operation. C records only this task's aggregate counters.
                let status = unsafe { ffi::radio_crypto_profile_start() };
                check(status, "crypto profile start")?;
                self.0 = State::Measuring(now_us + 30_000_000);
            }
            State::Measuring(deadline) if now_us >= deadline => {
                // SAFETY: same owner, with all synchronous crypto calls finished.
                // C disables counting before formatting its fixed-size summary.
                let status = unsafe { ffi::radio_crypto_profile_finish() };
                check(status, "crypto profile finish")?;
                self.0 = State::Complete;
            }
            _ => {}
        }
        Ok(())
    }
}
