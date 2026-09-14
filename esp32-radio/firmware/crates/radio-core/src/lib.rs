//! Hardware-independent music validation, playback, and browser/Worker protocols.
//!
//! This application support crate has no hardware, networking, clock, or FFI
//! dependencies. Callers supply elapsed time and perform the resulting effects.
#![forbid(unsafe_code)]

pub mod music;
pub mod playback;
pub mod protocol;
pub mod signaling;
pub mod spectrum;

pub mod now_playing;

pub mod metrics;
