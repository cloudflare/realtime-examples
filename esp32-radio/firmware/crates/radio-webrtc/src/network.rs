use crate::{Error, Peer, PeerState, Result};
use std::{io, io::ErrorKind, net::UdpSocket, time::Instant};
use str0m::{
    Event, IceConnectionState, Input, Output,
    net::{Protocol, Receive, Transmit},
};

impl Peer {
    /// Process a bounded batch so UDP traffic cannot indefinitely starve audio.
    pub fn poll(&mut self) -> Result<()> {
        let mut buffer = [0; 2048];
        for _ in 0..8 {
            let (length, source) = match self.socket.recv_from(&mut buffer) {
                Ok(packet) => packet,
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(Error::io("UDP receive failed", error)),
            };
            let Ok(contents) = buffer[..length].try_into() else {
                continue;
            };
            let receive = Receive {
                proto: Protocol::Udp,
                source,
                destination: self.local,
                contents,
            };
            let input = Input::Receive(Instant::now(), receive);
            if !self.rtc.accepts(&input) {
                continue;
            }
            let result = self.rtc.handle_input(input);
            self.drain()?;
            result.map_err(|_| Error::new("WebRTC input failed"))?;
        }
        let now = Instant::now();
        if now >= self.next_timeout {
            let result = self.rtc.handle_input(Input::Timeout(now));
            self.drain()?;
            result.map_err(|_| Error::new("WebRTC timer failed"))?;
        }
        if !self.rtc.is_alive() {
            self.state = PeerState::Lost;
        }
        Ok(())
    }

    pub(crate) fn drain(&mut self) -> Result<()> {
        self.drain_with(|socket, packet| socket.send_to(&packet.contents, packet.destination))
    }

    fn drain_with(
        &mut self,
        mut send: impl FnMut(&UdpSocket, &Transmit) -> io::Result<usize>,
    ) -> Result<()> {
        let mut send_error = None;
        loop {
            match self
                .rtc
                .poll_output()
                .map_err(|_| Error::new("WebRTC output failed"))?
            {
                Output::Timeout(next) => {
                    self.next_timeout = next;
                    return send_error.map_or(Ok(()), Err);
                }
                Output::Transmit(packet) => {
                    match send(&self.socket, &packet) {
                        Ok(_) => {}
                        // A saturated UDP interface loses a datagram; SCTP/ICE
                        // handle retransmission, while stale audio can be dropped.
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                        Err(error) => send_error = Some(Error::io("UDP send failed", error)),
                    }
                }
                Output::Event(Event::ChannelOpen(id, _)) if id == self.bootstrap => {
                    self.state = PeerState::Connected
                }
                Output::Event(Event::ChannelData(data)) => {
                    if self
                        .channels
                        .as_ref()
                        .is_some_and(|channels| channels.robot == data.id)
                    {
                        self.commands.push(data.binary, data.data);
                    }
                }
                Output::Event(Event::IceConnectionStateChange(
                    IceConnectionState::Disconnected,
                )) => self.state = PeerState::Lost,
                Output::Event(Event::Closed) => self.state = PeerState::Lost,
                Output::Event(Event::ChannelClose(id)) => {
                    if id == self.bootstrap
                        || self
                            .channels
                            .as_ref()
                            .is_some_and(|channels| id == channels.robot || id == channels.spectrum)
                    {
                        self.state = PeerState::Lost;
                    }
                }
                Output::Event(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
