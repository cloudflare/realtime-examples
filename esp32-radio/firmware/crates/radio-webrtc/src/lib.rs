//! One-owner WebRTC transport with explicit channel IDs and bounded application queues.
//!
//! The caller supplies a connected interface address and a fresh certificate,
//! exchanges SDP through its signaling service, and polls regularly. No ESP-IDF,
//! HTTP, playback, or hardware dependencies live here.
#![forbid(unsafe_code)]

mod audio;
mod channels;
mod connection;
mod network;

pub use channels::{SendOutcome, Stream};
pub use connection::{Certificate, Peer, PeerState};
pub use str0m::crypto;
pub use str0m::crypto::CryptoProvider;

/// Diagnostics never include SDP, credentials, certificates, or packet contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error {
    context: &'static str,
    code: Option<i32>,
}

impl Error {
    fn new(context: &'static str) -> Self {
        Self {
            context,
            code: None,
        }
    }
    fn io(context: &'static str, error: std::io::Error) -> Self {
        Self {
            context,
            code: error.raw_os_error(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.context)?;
        if let Some(code) = self.code {
            write!(f, " (OS code {code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

type Result<T> = std::result::Result<T, Error>;
