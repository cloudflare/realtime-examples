//! Safe application-facing boundary around ESP-IDF and its Rust HAL.
//! Native handles never escape.
//! This module exposes no application callbacks to C and adds no unsafe
//! Send/Sync implementations.
mod audio;
mod certificate;
mod crypto;
#[cfg(feature = "crypto-profile")]
mod crypto_profile;
mod ffi;
mod http;
mod metrics;
mod music;
mod task;

use crate::error::{Error, Result, check};
pub(crate) use audio::{Dsp, History};
pub(crate) use certificate::{certificate, ipv4};
pub(crate) use crypto::provider as crypto_provider;
#[cfg(feature = "crypto-profile")]
pub(crate) use crypto_profile::CryptoProfile;
pub(crate) use http::Http;
pub(crate) use metrics::Metrics;
pub(crate) use music::MusicStorage;
use radio_core::protocol::Color;
use std::{
    cell::Cell,
    ffi::CString,
    marker::PhantomData,
    sync::atomic::{AtomicBool, Ordering},
};
pub(crate) use task::SpawnConfig;

static BOARD_TAKEN: AtomicBool = AtomicBool::new(false);

/// Unique LED owner; moved to the radio thread after initialization, never shared.
#[derive(Debug)]
pub(crate) struct Board {
    _not_sync: PhantomData<Cell<()>>,
}

impl Board {
    pub(crate) fn init() -> Result<Self> {
        if BOARD_TAKEN.swap(true, Ordering::AcqRel) {
            return Err(Error::new("board already initialized"));
        }
        #[cfg(target_os = "espidf")]
        esp_idf_hal::sys::link_patches();
        // SAFETY: the atomic guard permits exactly one initialization; C owns all
        // driver state. It registers only C callbacks and borrows no Rust memory.
        let code = unsafe { ffi::radio_board_init() };
        check(code, "board initialization failed")?;
        loop {
            // SAFETY: Board initialization is the sole SNTP initializer, before
            // tasks needing certificate timestamps or verified HTTPS are spawned.
            match unsafe { ffi::radio_clock_sync() } {
                1 => break,
                -1 => return Err(Error::new("clock initialization failed")),
                _ => log("Waiting for time synchronization"),
            }
        }
        Ok(Self {
            _not_sync: PhantomData,
        })
    }
    pub(crate) fn set_led(&mut self, Color([r, g, b]): Color) -> Result<()> {
        // SAFETY: a Board exists only after initialization; &mut self serializes
        // LED calls and this sole owner is not Sync. Components fit the C ABI.
        check(unsafe { ffi::radio_led(r, g, b) }, "LED write failed")
    }
}

pub(crate) fn now_us() -> u64 {
    // SAFETY: thread-safe IDF monotonic timer; no borrowed state or pointers.
    unsafe { ffi::radio_now_us() }
}
pub(crate) fn random() -> u32 {
    // SAFETY: thread-safe IDF random API; no borrowed state or retained pointers.
    unsafe { ffi::radio_random() }
}
pub(crate) fn heap_free() -> u32 {
    // SAFETY: IDF serializes heap inspection internally; scalar result only.
    unsafe { ffi::radio_heap_free() }
}
pub(crate) fn stack_free() -> u32 {
    // SAFETY: query of the calling FreeRTOS task, with no external pointers.
    unsafe { ffi::radio_stack_free() }
}
pub(crate) fn console_byte() -> i32 {
    // SAFETY: called only by app_main's console loop; C stdio owns its buffer.
    unsafe { ffi::radio_console_byte() }
}
pub(crate) fn log(message: &str) {
    if let Ok(message) = CString::new(message) {
        // SAFETY: valid terminated string remains live until synchronous logging
        // returns. C uses "%s", so text cannot become a format string.
        unsafe { ffi::radio_log(message.as_ptr()) };
    }
}
pub(crate) fn recovery_attempt(reset: bool) -> u32 {
    // SAFETY: called only by signaling (or fatal recovery which never returns).
    // C retains the bounded scalar counter across software resets.
    unsafe { ffi::radio_recovery_attempt(i32::from(reset)) }
}
pub(crate) fn restart() -> ! {
    // SAFETY: IDF reset does not return or unwind and takes no borrowed memory.
    unsafe { ffi::radio_restart() }
}
