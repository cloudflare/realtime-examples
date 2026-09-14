//! Network drain failures after a real local ICE/DTLS/SCTP handshake.
use super::*;
use crate::{Certificate, PeerState};
use std::{
    net::Ipv4Addr,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use str0m::{Candidate, Rtc, change::SdpOffer, crypto::dtls::DtlsCert};

const CERT: &[u8] = include_bytes!("../../tests/fixtures/certificate.der");
const KEY: &[u8] = include_bytes!("../../tests/fixtures/key.der");

struct Remote {
    rtc: Rtc,
    socket: UdpSocket,
}

impl Remote {
    fn answer(offer: &str) -> (Self, String) {
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
        let mut remote = Self { rtc, socket };
        remote.drain();
        let answer = remote
            .rtc
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(offer).unwrap())
            .unwrap();
        remote.drain();
        remote
            .rtc
            .direct_api()
            .create_data_channel(crate::channels::config("server-events", 0, true));
        remote.drain();
        (remote, answer.to_sdp_string())
    }

    fn drain(&mut self) {
        loop {
            match self.rtc.poll_output().unwrap() {
                Output::Timeout(_) => return,
                Output::Transmit(packet) => {
                    self.socket
                        .send_to(&packet.contents, packet.destination)
                        .unwrap();
                }
                Output::Event(_) => {}
            }
        }
    }

    fn poll(&mut self) {
        let mut buffer = [0; 2048];
        loop {
            let (length, source) = match self.socket.recv_from(&mut buffer) {
                Ok(packet) => packet,
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => panic!("remote UDP receive failed: {error}"),
            };
            let receive = Receive {
                proto: Protocol::Udp,
                source,
                destination: self.socket.local_addr().unwrap(),
                contents: buffer[..length].try_into().unwrap(),
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

fn connected_peer() -> (Peer, Remote) {
    let certificate = Certificate::from_der(CERT.to_vec(), KEY.to_vec()).unwrap();
    let (mut peer, offer) = Peer::open(
        Ipv4Addr::LOCALHOST,
        certificate,
        Arc::new(str0m_rust_crypto::default_provider()),
    )
    .unwrap();
    let (mut remote, answer) = Remote::answer(&offer);
    peer.answer(&answer).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while peer.state() != PeerState::Connected {
        assert!(Instant::now() < deadline, "SCTP connection timed out");
        peer.poll().unwrap();
        remote.poll();
        thread::sleep(Duration::from_millis(1));
    }
    (peer, remote)
}

#[test]
fn hard_udp_send_failure_is_returned_after_queued_protocol_output_is_drained() {
    let (mut peer, _remote) = connected_peer();
    peer.rtc.close().unwrap();

    let mut attempts = 0;
    let error = peer
        .drain_with(|_, packet| {
            attempts += 1;
            assert!(!packet.contents.is_empty());
            Err(io::Error::new(
                ErrorKind::NetworkUnreachable,
                "injected UDP failure",
            ))
        })
        .unwrap_err();

    assert!(attempts > 0, "close emitted no network packets");
    assert_eq!(error.to_string(), "UDP send failed");
}
