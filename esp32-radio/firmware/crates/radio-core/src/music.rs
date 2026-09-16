//! Checked reader for Opus packs produced by `prepare_music.py`.
mod catalog;
pub use catalog::{Catalog, MAX_MUSIC_BYTES, MAX_TOTAL_FRAMES, MAX_TRACKS, ReadAt, Song};

use serde::Serialize;
use std::fmt;

pub const FRAME_MS: u32 = 20;
pub const BANDS: usize = 32;
pub const MAX_OPUS_BYTES: usize = 1275;
pub const MAX_TAG_BYTES: usize = 256;
const HEADER_BYTES: usize = 64;
const MAX_FRAMES: u32 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Header,
    Format,
    FrameCount,
    Truncated,
    PacketSize,
    Checksum,
    Metadata,
    Memory,
    TrackCount,
    Read,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Header => "invalid music pack header",
            Self::Format => "music must be stereo 48 kHz Opus with 20 ms frames",
            Self::FrameCount => "music frame count is outside the supported range",
            Self::Truncated => "music pack ends inside a frame",
            Self::PacketSize => "invalid Opus packet size",
            Self::Checksum => "music pack checksum mismatch",
            Self::Metadata => "invalid music title or artist",
            Self::Memory => "cannot allocate music frame index",
            Self::TrackCount => "music track count or index is outside the supported range",
            Self::Read => "music storage read failed",
        })
    }
}
impl std::error::Error for Error {}

/// Metadata from a validated song in the music catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub title: String,
    pub artist: String,
    pub duration_ms: u32,
}

fn tag(bytes: &[u8]) -> Result<&str, Error> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Metadata)?;
    if text.chars().any(char::is_control) {
        return Err(Error::Metadata);
    }
    Ok(text)
}

// Only called after validating the complete fixed-size header.
fn le32(bytes: &[u8], start: usize) -> u32 {
    u32::from_le_bytes(
        bytes[start..start + 4]
            .try_into()
            .expect("validated header"),
    )
}
