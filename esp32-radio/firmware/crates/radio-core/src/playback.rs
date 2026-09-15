//! Absolute playback deadlines. Late packets are skipped, never sent in a burst.
use crate::{music::FRAME_MS, protocol::Action};
use std::num::NonZeroU32;

const FRAME_US: u64 = FRAME_MS as u64 * 1000;

#[derive(Debug)]
pub struct Playback {
    frames: Vec<NonZeroU32>,
    track: usize,
    revision: u32,
    index: u32,
    elapsed: u64,
    next_us: u64,
    paused: bool,
    skipped: u64,
    epoch: u32,
    transition_pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    pub epoch: u32,
    pub track_index: u32,
    pub revision: u32,
    pub index: u32,
    pub pts_ms: u32,
    pub paused: bool,
    pub spectrum: bool,
}

impl Playback {
    pub fn new(frames: NonZeroU32, now_us: u64) -> Self {
        Self::playlist(vec![frames], now_us).expect("one nonempty song")
    }

    pub fn playlist(frames: Vec<NonZeroU32>, now_us: u64) -> Option<Self> {
        if frames.is_empty() || frames.len() > crate::music::MAX_TRACKS {
            return None;
        }
        Some(Self {
            frames,
            track: 0,
            revision: 0,
            index: 0,
            elapsed: 0,
            next_us: now_us,
            paused: false,
            skipped: 0,
            epoch: 0,
            transition_pending: false,
        })
    }

    /// Returns at most one packet per call; `now_us` comes from a monotonic clock.
    pub fn due(&mut self, now_us: u64) -> Option<Due> {
        if now_us < self.next_us {
            return None;
        }
        let late = (now_us - self.next_us) / FRAME_US;
        self.elapsed = self.elapsed.wrapping_add(late);
        self.skipped = self.skipped.saturating_add(late);
        if !self.paused {
            if self.transition_pending {
                self.next_track();
            }
            self.advance(late);
        }
        self.next_us = self
            .next_us
            .saturating_add((late + 1).saturating_mul(FRAME_US));
        let due = Due {
            epoch: self.epoch,
            track_index: self.track as u32,
            revision: self.revision,
            index: self.index,
            pts_ms: self.elapsed.wrapping_mul(FRAME_MS as u64) as u32,
            paused: self.paused,
            spectrum: self.elapsed % 2 == 0,
        };
        self.elapsed = self.elapsed.wrapping_add(1);
        if !self.paused {
            // Keep the emitted song current while its final packet is playing.
            // Commands may arrive before the next deadline commits the transition.
            if self.index + 1 == self.frames[self.track].get() {
                self.transition_pending = true;
            } else {
                self.index += 1;
            }
        }
        Some(due)
    }

    fn advance(&mut self, count: u64) {
        let total: u64 = self.frames.iter().map(|n| u64::from(n.get())).sum();
        let cycles = count / total;
        let changes = (cycles as u32).wrapping_mul(self.frames.len() as u32);
        self.epoch = self.epoch.wrapping_add(changes);
        self.revision = self.revision.wrapping_add(changes);
        let mut count = count % total;
        while count >= u64::from(self.frames[self.track].get() - self.index) {
            count -= u64::from(self.frames[self.track].get() - self.index);
            self.next_track();
        }
        self.index += count as u32;
    }

    fn next_track(&mut self) {
        self.transition_pending = false;
        self.track = (self.track + 1) % self.frames.len();
        self.index = 0;
        self.epoch = self.epoch.wrapping_add(1);
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn apply(&mut self, action: Action) {
        match action {
            Action::Play | Action::Pause => {
                let paused = action == Action::Pause;
                if paused != self.paused {
                    self.epoch = self.epoch.wrapping_add(1);
                }
                self.paused = paused;
            }
            Action::Next => self.next_track(),
            Action::Restart => {
                self.transition_pending = false;
                self.epoch = self.epoch.wrapping_add(1);
                self.revision = self.revision.wrapping_add(1);
                self.index = 0;
                self.paused = false;
            }
        }
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
    pub fn skipped_frames(&self) -> u64 {
        self.skipped
    }
}
