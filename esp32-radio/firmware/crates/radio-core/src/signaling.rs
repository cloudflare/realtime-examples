//! Validated Worker responses and recovery policy; no HTTP implementation here.
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    generation: String,
    session_description: Description,
}

#[derive(Deserialize)]
struct Description {
    r#type: String,
    sdp: String,
}

// SDP contains temporary transport credentials. Never derive Debug on it.
impl std::fmt::Debug for Started {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Started").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    generation: String,
}

impl Started {
    pub fn validate(self) -> Result<(Identity, String), &'static str> {
        if self.generation.is_empty()
            || self.generation.len() > 64
            || self.session_description.r#type != "answer"
            || !self.session_description.sdp.starts_with("v=0")
            || self.session_description.sdp.len() > 16_000
            || self.session_description.sdp.contains('\0')
        {
            return Err("invalid publisher answer");
        }
        Ok((
            Identity {
                generation: self.generation,
            },
            self.session_description.sdp,
        ))
    }
}

#[derive(Debug, Deserialize)]
pub struct Channels {
    channels: Vec<Channel>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    data_channel_name: String,
    id: u16,
}

/// Validated, distinct application stream IDs. SFU stream 0 carries server
/// events; 65535 is reserved by SCTP and cannot identify a data channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelIds {
    robot: u16,
    spectrum: u16,
}

impl ChannelIds {
    pub fn new(robot: u16, spectrum: u16) -> Result<Self, &'static str> {
        if robot == spectrum
            || [robot, spectrum]
                .iter()
                .any(|id| *id == 0 || *id == u16::MAX)
        {
            return Err("invalid application channel IDs");
        }
        Ok(Self { robot, spectrum })
    }
    pub fn robot(self) -> u16 {
        self.robot
    }
    pub fn spectrum(self) -> u16 {
        self.spectrum
    }
}

impl Channels {
    /// Match names rather than response order; use the IDs allocated by the SFU.
    pub fn validate(&self) -> Result<ChannelIds, &'static str> {
        let robot = self
            .channels
            .iter()
            .find(|c| c.data_channel_name == "robot");
        let spectrum = self
            .channels
            .iter()
            .find(|c| c.data_channel_name == "spectrum");
        match (self.channels.len(), robot, spectrum) {
            (2, Some(robot), Some(spectrum)) => ChannelIds::new(robot.id, spectrum.id),
            _ => Err("unexpected data channel allocation"),
        }
    }
}

pub fn retryable(status: i32) -> bool {
    status < 0 || status == 429 || status >= 500
}

/// Recover after a non-429 4xx response or more than 55 seconds without a
/// successful heartbeat.
pub fn needs_recovery(status: i32, since_success_us: u64) -> bool {
    ((400..500).contains(&status) && status != 429) || since_success_us > 55_000_000
}
