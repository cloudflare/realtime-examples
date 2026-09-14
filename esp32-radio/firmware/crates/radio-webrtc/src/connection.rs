use crate::{
    Error, Result,
    audio::Audio,
    channels::{self, Channels, Commands},
};
use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr, UdpSocket},
    sync::Arc,
    time::Instant,
};
use str0m::{
    Candidate, Rtc,
    change::{SdpAnswer, SdpPendingOffer},
    channel::ChannelId,
    crypto::dtls::DtlsCert,
    media::{Direction, MediaKind},
};

/// A DER X.509 certificate and its EC private key (PKCS#8 or SEC1 DER).
/// Debug deliberately redacts both buffers.
pub struct Certificate(DtlsCert);

impl Certificate {
    /// Takes ownership of the DER buffers and checks their lengths only.
    pub fn from_der(certificate: Vec<u8>, private_key: Vec<u8>) -> Result<Self> {
        if certificate.is_empty()
            || certificate.len() > 2048
            || private_key.is_empty()
            || private_key.len() > 512
        {
            return Err(Error::new("invalid certificate buffer size"));
        }
        Ok(Self(DtlsCert {
            certificate,
            private_key,
        }))
    }
}

impl fmt::Debug for Certificate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Certificate").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerState {
    Connecting,
    Connected,
    Lost,
}

/// Owns the socket and every str0m handle. Call only from the radio loop;
/// each mutation drains protocol output before another mutation is allowed.
pub struct Peer {
    pub(crate) rtc: Box<Rtc>,
    pub(crate) socket: UdpSocket,
    pub(crate) local: SocketAddr,
    pub(crate) next_timeout: Instant,
    pub(crate) state: PeerState,
    pub(crate) bootstrap: ChannelId,
    pub(crate) channels: Option<Channels>,
    pub(crate) commands: Commands,
    pending: Option<SdpPendingOffer>,
    audio: Audio,
}

impl fmt::Debug for Peer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Peer")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Peer {
    pub fn open(
        ip: Ipv4Addr,
        certificate: Certificate,
        crypto: Arc<crate::CryptoProvider>,
    ) -> Result<(Self, String)> {
        if ip.is_unspecified() {
            return Err(Error::new("interface has no IPv4 address"));
        }
        let socket = UdpSocket::bind((ip, 0)).map_err(|_| Error::new("UDP bind failed"))?;
        socket
            .set_nonblocking(true)
            .map_err(|_| Error::new("UDP configuration failed"))?;
        let local = socket
            .local_addr()
            .map_err(|_| Error::new("UDP address unavailable"))?;
        let now = Instant::now();
        // Keep the large protocol state off the constrained radio task stack.
        let mut rtc = Box::new(
            Rtc::builder()
                .set_crypto_provider(crypto)
                .set_dtls_cert(certificate.0)
                .clear_codecs()
                .enable_opus(true)
                .set_rtp_mode(true)
                // Leave room for SFU events before the smaller command filter.
                // Stream-state count is independent of negotiated stream IDs.
                .set_sctp_receive_limits(str0m::channel::SctpReceiveLimits::new(
                    8 * 1024,
                    32 * 1024,
                    64,
                    8,
                ))
                .build(now),
        );
        let candidate =
            Candidate::host(local, "udp").map_err(|_| Error::new("invalid ICE candidate"))?;
        rtc.add_local_candidate(candidate);
        // No peer or negotiated transport exists yet, so adding the candidate
        // cannot emit network packets or application events.
        while !matches!(
            rtc.poll_output()
                .map_err(|_| Error::new("ICE setup failed"))?,
            str0m::Output::Timeout(_)
        ) {}
        let mut change = rtc.sdp_api();
        let audio_mid = change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        // SFU stream 0 is reserved for server events. Including it in the offer
        // establishes SCTP before the SFU allocates the two application IDs.
        let bootstrap = change.add_channel_with_config(channels::config("server-events", 0, true));
        let (offer, pending) = change.apply().ok_or(Error::new("offer unavailable"))?;
        let mut peer = Self {
            rtc,
            socket,
            local,
            next_timeout: now,
            state: PeerState::Connecting,
            bootstrap,
            channels: None,
            commands: Commands::default(),
            pending: Some(pending),
            audio: Audio::new(audio_mid),
        };
        peer.drain()?;
        let offer = offer.to_sdp_string();
        if offer.len() > 16000 {
            return Err(Error::new("local SDP too large"));
        }
        Ok((peer, offer))
    }

    pub fn answer(&mut self, sdp: &str) -> Result<()> {
        if sdp.len() > 16000 {
            return Err(Error::new("remote SDP too large"));
        }
        let answer =
            SdpAnswer::from_sdp_string(sdp).map_err(|_| Error::new("invalid remote SDP"))?;
        let pending = self
            .pending
            .take()
            .ok_or(Error::new("answer already applied"))?;
        let result = self.rtc.sdp_api().accept_answer(pending, answer);
        self.drain()?;
        result.map_err(|_| Error::new("peer rejected answer"))
    }

    pub fn state(&self) -> PeerState {
        self.state
    }

    /// An already encoded 20 ms stereo Opus frame. `pts_ms` is transport time in ms;
    /// restarting or changing a song must not reset it.
    pub fn audio(&mut self, pts_ms: u32, bytes: &[u8]) -> Result<()> {
        let result = self.audio.write(&mut self.rtc, pts_ms, bytes);
        self.drain()?;
        result
    }

    /// Initiate protocol shutdown. Continue polling until lost or a caller-owned
    /// deadline, then drop to release the socket and all transport allocations.
    pub fn close(&mut self) -> Result<()> {
        let result = self.rtc.close();
        self.drain()?;
        result.map_err(|_| Error::new("transport close failed"))
    }
}
