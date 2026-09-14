//! Real UDP/DTLS/SCTP tests without credentials, Cloudflare, or hardware.
use radio_core::signaling::ChannelIds;
use radio_webrtc::{Certificate, Peer, PeerState, SendOutcome, Stream};
use std::{
    net::{Ipv4Addr, UdpSocket},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use str0m::{
    Candidate, Event, Input, Output, Rtc,
    change::SdpOffer,
    channel::{ChannelConfig, ChannelId, Reliability},
    crypto::dtls::DtlsCert,
    net::{Protocol, Receive},
};

const CERT: &[u8] = include_bytes!("fixtures/certificate.der");
const KEY: &[u8] = include_bytes!("fixtures/key.der");

struct Listener {
    rtc: Rtc,
    socket: UdpSocket,
    messages: Vec<Vec<u8>>,
    audio: usize,
    drop_data: bool,
    data_packets: usize,
}

impl Listener {
    fn new(offer: &str) -> (Self, String) {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        socket.set_nonblocking(true).unwrap();
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m_rust_crypto::default_provider()))
            .set_dtls_cert(DtlsCert {
                certificate: CERT.to_vec(),
                private_key: KEY.to_vec(),
            })
            .clear_codecs()
            .enable_opus(true)
            .build(Instant::now());
        rtc.add_local_candidate(Candidate::host(socket.local_addr().unwrap(), "udp").unwrap());
        let mut this = Self {
            rtc,
            socket,
            messages: Vec::new(),
            audio: 0,
            drop_data: false,
            data_packets: 0,
        };
        this.drain();
        let answer = this
            .rtc
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(offer).unwrap())
            .unwrap();
        this.drain();
        this.channel(0, true);
        (this, answer.to_sdp_string())
    }

    fn channel(&mut self, id: u16, reliable: bool) -> ChannelId {
        let id = self.rtc.direct_api().create_data_channel(ChannelConfig {
            label: format!("test-{id}"),
            negotiated: Some(id),
            ordered: reliable,
            reliability: if reliable {
                Reliability::Reliable
            } else {
                Reliability::MaxRetransmits { retransmits: 0 }
            },
            ..Default::default()
        });
        self.drain();
        id
    }

    fn drain(&mut self) {
        loop {
            match self.rtc.poll_output().unwrap() {
                Output::Timeout(_) => return,
                Output::Transmit(packet) => {
                    if packet.contents.first() == Some(&23) {
                        self.data_packets += 1;
                        if self.drop_data && self.data_packets % 5 == 0 {
                            continue;
                        }
                    }
                    self.socket
                        .send_to(&packet.contents, packet.destination)
                        .unwrap();
                }
                Output::Event(Event::ChannelData(data)) => self.messages.push(data.data),
                Output::Event(Event::MediaData(data)) => {
                    assert_eq!(data.data.as_ref(), radio_core::protocol::SILENCE);
                    self.audio += 1;
                }
                _ => {}
            }
        }
    }

    fn poll(&mut self) {
        let mut buffer = [0; 2048];
        while let Ok((n, source)) = self.socket.recv_from(&mut buffer) {
            let receive = Receive {
                proto: Protocol::Udp,
                source,
                destination: self.socket.local_addr().unwrap(),
                contents: buffer[..n].try_into().unwrap(),
            };
            self.rtc
                .handle_input(Input::Receive(Instant::now(), receive))
                .unwrap();
            self.drain();
        }
        self.rtc
            .handle_input(Input::Timeout(Instant::now()))
            .unwrap();
        self.drain();
    }
}

fn connected_pair() -> (Peer, Listener) {
    let certificate = Certificate::from_der(CERT.to_vec(), KEY.to_vec()).unwrap();
    let (mut peer, offer) = Peer::open(
        Ipv4Addr::LOCALHOST,
        certificate,
        Arc::new(str0m_rust_crypto::default_provider()),
    )
    .unwrap();
    let (mut listener, answer) = Listener::new(&offer);
    peer.answer(&answer).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while peer.state() != PeerState::Connected {
        assert!(Instant::now() < deadline, "SCTP connection timed out");
        peer.poll().unwrap();
        listener.poll();
        thread::sleep(Duration::from_millis(1));
    }
    (peer, listener)
}

#[test]
fn negotiated_ids_audio_commands_loss_and_teardown() {
    for _ in 0..2 {
        let (mut peer, mut listener) = connected_pair();
        let ids = ChannelIds::new(6, 10).unwrap();
        peer.create_channels(ids).unwrap();
        assert!(peer.create_channels(ids).is_err());
        let robot = listener.channel(6, true);
        listener.channel(10, false);
        listener.drop_data = true;
        let mut commands = Vec::new();
        let mut sent = 0;
        let mut audio_sent = 0;
        let mut next_audio = Instant::now();
        let deadline = Instant::now() + Duration::from_secs(10);
        while commands.len() < 20 || listener.audio < 5 || listener.messages.len() < 20 {
            assert!(Instant::now() < deadline, "media/data delivery timed out");
            peer.poll().unwrap();
            listener.poll();
            if sent < 20
                && let Some(mut channel) = listener.rtc.channel(robot)
            {
                assert!(channel.write(false, &[sent]).unwrap());
                listener.drain();
                assert_eq!(
                    peer.data(Stream::Robot, &[sent]).unwrap(),
                    SendOutcome::Sent
                );
                assert_eq!(
                    peer.data(Stream::Spectrum, &[sent]).unwrap(),
                    SendOutcome::Sent
                );
                sent += 1;
            }
            if Instant::now() >= next_audio {
                peer.audio(audio_sent * 20, radio_core::protocol::SILENCE)
                    .unwrap();
                audio_sent += 1;
                next_audio += Duration::from_millis(20);
            }
            let mut out = [0; 512];
            if peer.command(&mut out).unwrap() > 0 {
                commands.push(out[0]);
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(commands, (0..20).collect::<Vec<_>>());
        assert_eq!(peer.dropped(), 0);
        peer.close().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while peer.state() != PeerState::Lost {
            assert!(Instant::now() < deadline, "local close timed out");
            peer.poll().unwrap();
            listener.poll();
        }
        drop(peer);
    }
}

#[test]
fn data_backpressure_is_recoverable_but_unavailable_and_closed_channels_are_errors() {
    let (mut peer, mut listener) = connected_pair();
    assert!(peer.data(Stream::Robot, b"before channels").is_err());

    let ids = ChannelIds::new(6, 10).unwrap();
    peer.create_channels(ids).unwrap();
    let robot = listener.channel(6, true);
    listener.channel(10, false);

    let payload = [0x42; 2048];
    // The application performs this normal protocol drive after handling its
    // Start request and before entering the playback/send portion of the loop.
    peer.poll().unwrap();
    listener.poll();
    assert_eq!(
        peer.data(Stream::Robot, &payload).unwrap(),
        SendOutcome::Sent
    );
    let mut accepted = 1;
    while let SendOutcome::Sent = peer.data(Stream::Robot, &payload).unwrap() {
        accepted += 1;
        assert!(
            accepted < 128,
            "reliable channel never applied backpressure"
        );
    }
    assert!(accepted > 0);
    assert_eq!(peer.state(), PeerState::Connected);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            Instant::now() < deadline,
            "data channel stayed backpressured"
        );
        peer.poll().unwrap();
        listener.poll();
        match peer.data(Stream::Robot, b"after backpressure").unwrap() {
            SendOutcome::Sent => break,
            SendOutcome::Backpressured => thread::sleep(Duration::from_millis(1)),
        }
    }
    assert_eq!(peer.state(), PeerState::Connected);

    listener.rtc.direct_api().close_data_channel(robot);
    listener.drain();
    let deadline = Instant::now() + Duration::from_secs(10);
    while peer.state() != PeerState::Lost {
        assert!(Instant::now() < deadline, "remote channel close timed out");
        peer.poll().unwrap();
        listener.poll();
        thread::sleep(Duration::from_millis(1));
    }
    assert!(peer.data(Stream::Robot, b"after close").is_err());
}

#[test]
fn an_answer_with_the_wrong_certificate_fingerprint_is_rejected() {
    let certificate = Certificate::from_der(CERT.to_vec(), KEY.to_vec()).unwrap();
    let (mut peer, offer) = Peer::open(
        Ipv4Addr::LOCALHOST,
        certificate,
        Arc::new(str0m_rust_crypto::default_provider()),
    )
    .unwrap();
    let (mut listener, answer) = Listener::new(&offer);
    let tampered = answer
        .lines()
        .map(|line| {
            if line.starts_with("a=fingerprint:sha-256 ") {
                format!("a=fingerprint:sha-256 {}", ["00"; 32].join(":"))
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
        + "\r\n";
    assert_ne!(answer, tampered);
    peer.answer(&tampered).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut rejected = false;
    while Instant::now() < deadline {
        listener.poll();
        if peer.poll().is_err() || peer.state() == PeerState::Lost {
            rejected = true;
            break;
        }
        assert_ne!(peer.state(), PeerState::Connected);
        thread::sleep(Duration::from_millis(1));
    }
    assert!(rejected, "fingerprint mismatch must fail the handshake");
}
