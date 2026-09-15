//! A song instance within one publisher generation; independent of the RTP clock.
use crate::{
    music::{Catalog, Error, FRAME_MS, Track},
    playback::Due,
};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub revision: u32,
    pub track_index: u32,
    pub track_count: u32,
    pub track: Option<Track>,
}

/// Published state describes the most recent frame returned by
/// [`Playback::due`](crate::playback::Playback::due).
/// Use the same immutable catalog for construction and subsequent updates.
#[derive(Debug)]
pub struct Snapshot {
    pub now_playing: NowPlaying,
    pub position_ms: u32,
    pub duration_ms: u32,
}

impl Snapshot {
    pub fn new(catalog: &Catalog) -> Self {
        let first = &catalog.songs()[0];
        Self {
            now_playing: NowPlaying {
                revision: 0,
                track_index: 0,
                track_count: catalog.songs().len() as u32,
                track: first.metadata.clone(),
            },
            position_ms: 0,
            duration_ms: first.frames.get() * FRAME_MS,
        }
    }

    /// Records a due frame and reports whether its playback revision changed.
    pub fn record(&mut self, catalog: &Catalog, due: Due) -> Result<bool, Error> {
        let song = catalog
            .songs()
            .get(due.track_index as usize)
            .ok_or(Error::TrackCount)?;
        if due.index >= song.frames.get() {
            return Err(Error::FrameCount);
        }
        let changed = due.revision != self.now_playing.revision;
        if changed {
            self.now_playing = NowPlaying {
                revision: due.revision,
                track_index: due.track_index,
                track_count: catalog.songs().len() as u32,
                track: song.metadata.clone(),
            };
        }
        self.position_ms = due.index * FRAME_MS;
        self.duration_ms = song.frames.get() * FRAME_MS;
        Ok(changed)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message<'a> {
    pub event: &'static str,
    pub now_playing: &'a NowPlaying,
}
