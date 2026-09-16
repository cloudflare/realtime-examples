//! Authenticated RTP over an in-memory network with public fixture keys.
use super::Audio;
use radio_core::{music::MAX_OPUS_BYTES, protocol::SILENCE};
use std::{
    collections::VecDeque,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use str0m::{
    Candidate, Event, Input, Output, Rtc,
    crypto::dtls::DtlsCert,
    format::{Codec, FormatParams},
    media::{Direction, Frequency, MediaKind, Mid, Pt},
    net::{Protocol, Receive, Transmit},
    rtp::{RtpPacket, Ssrc},
};

struct Endpoint {
    rtc: Rtc,
    outbound: VecDeque<Transmit>,
    received: Vec<RtpPacket>,
}

impl Endpoint {
    fn new(port: u16, now: Instant) -> Self {
        let mut config = Rtc::builder()
            .set_crypto_provider(Arc::new(str0m_rust_crypto::default_provider()))
            .set_dtls_cert(DtlsCert {
                certificate: include_bytes!("../../tests/fixtures/certificate.der").to_vec(),
                private_key: include_bytes!("../../tests/fixtures/key.der").to_vec(),
            })
            .clear_codecs()
            .set_rtp_mode(true);
        // A non-default dynamic PT detects accidental hard-coded Opus values.
        config.codec_config().add_config(
            103.into(),
            None,
            Codec::Opus,
            Frequency::FORTY_EIGHT_KHZ,
            Some(2),
            FormatParams::default(),
        );
        let mut this = Self {
            rtc: config.build(now),
            outbound: VecDeque::new(),
            received: Vec::new(),
        };
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        this.rtc
            .add_local_candidate(Candidate::host(address, "udp").unwrap());
        this.drain();
        this
    }

    fn drain(&mut self) {
        loop {
            match self.rtc.poll_output().unwrap() {
                Output::Timeout(_) => break,
                Output::Transmit(packet) => self.outbound.push_back(packet),
                Output::Event(Event::RtpPacket(packet)) => self.received.push(packet),
                _ => {}
            }
        }
    }

    fn receive(&mut self, packet: &Transmit, now: Instant) {
        let receive = Receive::new(
            Protocol::Udp,
            packet.source,
            packet.destination,
            &packet.contents,
        )
        .unwrap();
        let input = Input::Receive(now, receive);
        assert!(self.rtc.accepts(&input));
        self.rtc.handle_input(input).unwrap();
        self.drain();
    }

    fn timeout(&mut self, now: Instant) {
        self.rtc.handle_input(Input::Timeout(now)).unwrap();
        self.drain();
    }
}

struct Pair {
    sender: Endpoint,
    receiver: Endpoint,
    audio: Audio,
    pt: Pt,
    ssrc: Ssrc,
    now: Instant,
    wire_audio: Vec<Transmit>,
    drop_next: bool,
}

impl Pair {
    fn new() -> Self {
        let now = Instant::now();
        let mut sender = Endpoint::new(41000, now);
        let mut receiver = Endpoint::new(42000, now);
        let mut changes = sender.rtc.sdp_api();
        let mid = changes.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
        let (offer, pending) = changes.apply().unwrap();
        sender.drain();
        let answer = receiver.rtc.sdp_api().accept_offer(offer).unwrap();
        receiver.drain();
        sender.rtc.sdp_api().accept_answer(pending, answer).unwrap();
        sender.drain();
        let pt = sender.rtc.media(mid).unwrap().remote_pts()[0];
        let ssrc = sender
            .rtc
            .direct_api()
            .stream_tx_by_mid(mid, None)
            .unwrap()
            .ssrc();
        let mut this = Self {
            sender,
            receiver,
            audio: Audio::new(mid),
            pt,
            ssrc,
            now,
            wire_audio: Vec::new(),
            drop_next: false,
        };
        for _ in 0..5000 {
            this.progress();
            if this.sender.rtc.is_connected() && this.receiver.rtc.is_connected() {
                return this;
            }
        }
        panic!("public-fixture DTLS handshake timed out");
    }

    fn progress(&mut self) {
        self.now += Duration::from_millis(1);
        self.sender.timeout(self.now);
        self.receiver.timeout(self.now);
        for _ in 0..100 {
            if self.sender.outbound.is_empty() && self.receiver.outbound.is_empty() {
                return;
            }
            while let Some(packet) = self.sender.outbound.pop_front() {
                let is_audio =
                    packet.contents[0] & 0xc0 == 0x80 && !(192..=223).contains(&packet.contents[1]);
                let drop = is_audio && std::mem::take(&mut self.drop_next);
                if !drop {
                    self.receiver.receive(&packet, self.now);
                }
                if is_audio {
                    self.wire_audio.push(packet);
                }
            }
            while let Some(packet) = self.receiver.outbound.pop_front() {
                self.sender.receive(&packet, self.now);
            }
        }
        panic!("in-memory network did not quiesce");
    }

    fn send(&mut self, pts_ms: u32, bytes: &[u8]) {
        self.audio
            .write(&mut self.sender.rtc, pts_ms, bytes)
            .unwrap();
        self.sender.drain();
        for _ in 0..20 {
            self.progress();
        }
    }
}

#[test]
fn opus_payload_ownership_identity_and_clock_survive_rollover() {
    let mut pair = Pair::new();
    pair.audio.next_seq = 65_534.into();
    // The second packet crosses the 32-bit RTP timestamp boundary.
    let first_pts = 89_478_480_u32;
    let packets = [
        vec![0xf8; MAX_OPUS_BYTES],
        SILENCE.to_vec(),
        vec![0xfc; 240],
    ];
    for (index, expected) in packets.iter().enumerate() {
        let mut producer_buffer = expected.clone();
        pair.audio
            .write(
                &mut pair.sender.rtc,
                first_pts + index as u32 * 20,
                &producer_buffer,
            )
            .unwrap();
        // The caller may immediately refill the music buffer, even before the
        // str0m queue is flushed. The transmitted bytes must remain unchanged.
        producer_buffer.fill(0);
        pair.sender.drain();
        for _ in 0..20 {
            pair.progress();
        }
    }
    assert_eq!(pair.receiver.received.len(), packets.len());
    for (index, (received, expected)) in pair.receiver.received.iter().zip(&packets).enumerate() {
        assert_eq!(received.payload.as_ref(), expected);
        assert_eq!(received.header.payload_type, pair.pt);
        assert_eq!(received.header.ssrc, pair.ssrc);
        assert_eq!(received.header.sequence_number, (65_534 + index) as u16);
        assert_eq!(
            received.header.timestamp,
            (first_pts + index as u32 * 20).wrapping_mul(48)
        );
        assert!(!received.header.marker);
    }
    assert_eq!(
        pair.receiver.received[0].header.ext_vals.mid,
        Some(pair.audio.mid)
    );
    assert_eq!(pair.wire_audio.len(), packets.len());
    // 1500-byte IPv4 path minus the 20-byte IP and 8-byte UDP headers.
    assert!(
        pair.wire_audio
            .iter()
            .all(|packet| packet.contents.len() <= 1472)
    );
    assert!(pair.wire_audio[0].contents.len() > MAX_OPUS_BYTES);
}

#[test]
fn loss_and_replay_do_not_repeat_audio_or_reuse_sequences() {
    let mut pair = Pair::new();
    let start = *pair.audio.next_seq;
    pair.send(u32::MAX - 15, SILENCE);
    pair.drop_next = true;
    pair.send(4, &[0xf8; 240]);
    pair.send(24, SILENCE);
    assert_eq!(pair.receiver.received.len(), 2);
    assert_eq!(
        pair.receiver.received[1].header.sequence_number,
        (start + 2) as u16
    );
    assert_eq!(
        pair.receiver.received[1]
            .header
            .timestamp
            .wrapping_sub(pair.receiver.received[0].header.timestamp),
        1920
    );

    // The lost packet is still unseen by SRTP: a forged authentication tag
    // must not be accepted as fresh audio.
    let lost = &pair.wire_audio[1];
    let mut corrupted = lost.contents.to_vec();
    *corrupted.last_mut().unwrap() ^= 1;
    pair.receiver.receive(
        &Transmit {
            proto: lost.proto,
            source: lost.source,
            destination: lost.destination,
            contents: corrupted.into(),
        },
        pair.now,
    );
    assert_eq!(pair.receiver.received.len(), 2);

    // Replaying a valid encrypted packet cannot deliver its Opus payload again.
    pair.receiver.receive(&pair.wire_audio[0], pair.now);
    assert_eq!(pair.receiver.received.len(), 2);
    let next = pair.audio.next_seq;
    assert!(pair.audio.write(&mut pair.sender.rtc, 44, &[]).is_err());
    assert!(
        pair.audio
            .write(&mut pair.sender.rtc, 44, &[0; MAX_OPUS_BYTES + 1])
            .is_err()
    );
    assert_eq!(pair.audio.next_seq, next);
    pair.send(44, &[0xfc; 240]);
    assert_eq!(
        pair.receiver.received[2].header.sequence_number,
        (start + 3) as u16
    );

    pair.sender.rtc.close().unwrap();
    pair.sender.drain();
    let next = pair.audio.next_seq;
    assert!(pair.audio.write(&mut pair.sender.rtc, 64, SILENCE).is_err());
    assert_eq!(pair.audio.next_seq, next);
}

#[test]
fn audio_requires_an_authenticated_transport() {
    let mut endpoint = Endpoint::new(43000, Instant::now());
    let mut audio = Audio::new(Mid::new());
    let next = audio.next_seq;
    assert!(audio.write(&mut endpoint.rtc, 0, SILENCE).is_err());
    assert_eq!(audio.next_seq, next);
    assert!(endpoint.outbound.is_empty());
}
