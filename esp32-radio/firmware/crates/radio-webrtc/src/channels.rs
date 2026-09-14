use crate::{Error, Peer, Result};
use radio_core::{protocol::COMMAND_LIMIT, signaling::ChannelIds};
use std::collections::VecDeque;
use str0m::channel::{ChannelConfig, ChannelId, Reliability};

const COMMAND_QUEUE: usize = 16;
const DATA_LIMIT: usize = 2048;
const BUFFERED_LIMIT: usize = 8192;

/// Application purpose, independent of each connection's SCTP stream IDs.
#[derive(Debug, Clone, Copy)]
pub enum Stream {
    Robot,
    Spectrum,
}

/// Whether a bounded application message entered the transport's send queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub enum SendOutcome {
    Sent,
    Backpressured,
}

pub(crate) fn config(label: &str, id: u16, ordered: bool) -> ChannelConfig {
    ChannelConfig {
        label: label.to_owned(),
        negotiated: Some(id),
        ordered,
        reliability: if ordered {
            Reliability::Reliable
        } else {
            Reliability::MaxRetransmits { retransmits: 0 }
        },
        ..Default::default()
    }
}

pub(crate) struct Channels {
    pub robot: ChannelId,
    pub spectrum: ChannelId,
}

#[derive(Default)]
pub(crate) struct Commands {
    queue: VecDeque<Vec<u8>>,
    pub dropped: u32,
}

impl Commands {
    pub fn push(&mut self, binary: bool, bytes: Vec<u8>) {
        if binary
            || bytes.is_empty()
            || bytes.len() > COMMAND_LIMIT
            || self.queue.len() == COMMAND_QUEUE
        {
            self.dropped = self.dropped.saturating_add(1);
        } else {
            self.queue.push_back(bytes);
        }
    }

    pub fn pop(&mut self, out: &mut [u8]) -> Result<usize> {
        let Some(bytes) = self.queue.front() else {
            return Ok(0);
        };
        if out.len() < bytes.len() {
            return Err(Error::new("command output buffer too small"));
        }
        let length = bytes.len();
        out[..length].copy_from_slice(bytes);
        self.queue.pop_front();
        Ok(length)
    }
}

impl Peer {
    /// Install the IDs returned by the SFU. No DCEP OPEN is sent.
    pub fn create_channels(&mut self, ids: ChannelIds) -> Result<()> {
        if self.channels.is_some() || self.state != crate::PeerState::Connected {
            return Err(Error::new("channels require a fresh connected transport"));
        }
        let robot = self
            .rtc
            .direct_api()
            .create_data_channel(config("robot", ids.robot(), true));
        self.drain()?;
        let spectrum =
            self.rtc
                .direct_api()
                .create_data_channel(config("spectrum", ids.spectrum(), false));
        self.drain()?;
        self.channels = Some(Channels { robot, spectrum });
        Ok(())
    }

    /// Send one message, refusing new data when the connection is backed up.
    pub fn data(&mut self, stream: Stream, bytes: &[u8]) -> Result<SendOutcome> {
        if bytes.is_empty() || bytes.len() > DATA_LIMIT {
            return Err(Error::new("invalid data message size"));
        }
        let channels = self
            .channels
            .as_ref()
            .ok_or(Error::new("channels unavailable"))?;
        let id = match stream {
            Stream::Robot => channels.robot,
            Stream::Spectrum => channels.spectrum,
        };
        let mut channel = self
            .rtc
            .channel(id)
            .ok_or(Error::new("channel is not open"))?;
        if channel.buffered_amount().saturating_add(bytes.len()) > BUFFERED_LIMIT {
            return Ok(SendOutcome::Backpressured);
        }
        let result = channel.write(matches!(stream, Stream::Spectrum), bytes);
        self.drain()?;
        match result {
            Ok(true) => Ok(SendOutcome::Sent),
            Ok(false) => Ok(SendOutcome::Backpressured),
            Err(_) => Err(Error::new("data send failed")),
        }
    }

    /// Copy the oldest accepted command; consumes at most one per call.
    pub fn command(&mut self, out: &mut [u8]) -> Result<usize> {
        self.commands.pop(out)
    }

    pub fn dropped(&self) -> u32 {
        self.commands.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_stay_ordered_and_bounded_even_when_flooded() {
        let mut commands = Commands::default();
        for n in 0..20 {
            commands.push(false, vec![n]);
        }
        commands.push(true, vec![42]);
        commands.push(false, vec![42; COMMAND_LIMIT + 1]);
        assert_eq!(commands.dropped, 6);
        assert!(commands.pop(&mut []).is_err());
        let mut out = [0; COMMAND_LIMIT];
        for n in 0..16 {
            assert_eq!(commands.pop(&mut out).unwrap(), 1);
            assert_eq!(out[0], n);
        }
        assert_eq!(commands.pop(&mut out).unwrap(), 0);
    }
}
