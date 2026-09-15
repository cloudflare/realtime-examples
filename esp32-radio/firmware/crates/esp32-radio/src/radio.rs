//! One task owns the peer, playback clock, LED, counters, and packet buffers.
use crate::{
    error::{Error, Result},
    platform::{self, Board, MusicStorage},
};
use radio_core::{
    music::{Catalog, MAX_OPUS_BYTES},
    now_playing::{Message as NowPlayingMessage, NowPlaying, Snapshot},
    playback::Playback,
    protocol::{self, Ack, Color, Command, Telemetry},
    signaling::ChannelIds,
};
use radio_webrtc::{Peer, PeerState, SendOutcome, Stream};
use std::{
    sync::{
        Arc,
        mpsc::{Receiver, SyncSender},
    },
    thread,
    time::Duration,
};

pub(crate) enum Request {
    Answer(String, SyncSender<Result<()>>),
    Start(ChannelIds, SyncSender<Result<()>>),
}
pub(crate) enum Event {
    Offer {
        sdp: String,
        now_playing: NowPlaying,
    },
    Connected,
    Lost,
}

// SDP-bearing messages intentionally have no Debug implementation.

#[derive(Debug, Default)]
struct Counters {
    data: u64,
    rejected: u64,
    sequence: u64,
}

pub(crate) fn run(
    mut board: Board,
    requests: Receiver<Request>,
    events: SyncSender<Event>,
    mut analysis: crate::analysis::Client,
    station: crate::station::Station,
    mut metrics: crate::metrics::Client,
) -> Result<()> {
    let mut storage = MusicStorage::open()?;
    let catalog = Catalog::parse(&mut storage)?;
    platform::log(&format!(
        "Music validated: tracks={} bytes={} cache_bytes={} index_bytes={}",
        catalog.songs().len(),
        catalog.used_bytes(),
        storage.cache_bytes(),
        catalog.index_bytes()
    ));
    storage.finish_validation();
    let mut published = Snapshot::new(&catalog);
    station.publish(&published.now_playing)?;
    let mut emitted = false;
    let mut opus_buffer = [0; MAX_OPUS_BYTES];
    let certificate = platform::certificate()?;
    platform::log("DTLS certificate generated on device; starting str0m");
    let initializing = platform::now_us();
    let crypto = Arc::new(platform::crypto_provider());
    let (mut peer, offer) = Peer::open(platform::ipv4()?, certificate, crypto)?;
    platform::log(&format!(
        "str0m initialized in {} ms",
        (platform::now_us() - initializing) / 1000
    ));
    events
        .try_send(Event::Offer {
            sdp: offer,
            now_playing: published.now_playing.clone(),
        })
        .map_err(|_| Error::new("signaling event queue unavailable"))?;
    let mut playback = None;
    let mut led = Color([0, 12, 4]);
    let mut counters = Counters::default();
    let mut next_telemetry = 0;
    let mut next_stack_sample = 0;
    let mut stack_free = 0;
    let mut previous = PeerState::Connecting;
    let mut command_buffer = [0; protocol::COMMAND_LIMIT];
    let mut json_buffer = Vec::with_capacity(2048);
    #[cfg(feature = "crypto-profile")]
    let mut crypto_profile = platform::CryptoProfile::default();
    loop {
        if let Ok(request) = requests.try_recv() {
            match request {
                Request::Answer(sdp, reply) => {
                    let _ = reply.send(peer.answer(&sdp).map_err(Error::from));
                }
                Request::Start(ids, reply) => {
                    let result = if playback.is_some() {
                        Err(Error::new("playback already started"))
                    } else {
                        peer.create_channels(ids).map_err(Error::from)
                    };
                    if result.is_ok() {
                        playback = Playback::playlist(
                            catalog.songs().iter().map(|song| song.frames).collect(),
                            platform::now_us(),
                        );
                    }
                    let _ = reply.send(result);
                }
            }
        }
        peer.poll()?;
        let state = peer.state();
        if state != previous {
            if state == PeerState::Connected {
                events
                    .try_send(Event::Connected)
                    .map_err(|_| Error::new("signaling event queue unavailable"))?;
                platform::log("str0m: WebRTC audio and SCTP connected");
            } else if state == PeerState::Lost {
                let _ = events.try_send(Event::Lost);
                return Err(Error::new("WebRTC transport disconnected"));
            }
            previous = state;
        }
        if let Some(player) = playback.as_mut().filter(|_| state == PeerState::Connected) {
            // Bound per-tick work even if a controller floods the reliable stream.
            let length = peer.command(&mut command_buffer)?;
            if length > 0 {
                match Command::parse(&command_buffer[..length]) {
                    Ok(command) => {
                        let mut result = 0;
                        if let Some(color) = command.led {
                            if board.set_led(color).is_ok() {
                                led = color;
                            } else {
                                result = -1;
                            }
                        }
                        if let Some(action) = command.action {
                            player.apply(action);
                        }
                        let ack = Ack {
                            event: "ack",
                            command_id: command.command_id.as_deref(),
                            result,
                            led,
                            paused: player.paused(),
                        };
                        send_json(&mut peer, &ack, &mut json_buffer, &mut counters)?;
                    }
                    Err(_) => counters.rejected = counters.rejected.saturating_add(1),
                }
            }
            let now = platform::now_us();
            if let Some(due) = player.due(now) {
                emitted = true;
                if published.record(&catalog, due)? {
                    station.publish(&published.now_playing)?;
                    send_json(
                        &mut peer,
                        &NowPlayingMessage {
                            event: "nowPlaying",
                            now_playing: &published.now_playing,
                        },
                        &mut json_buffer,
                        &mut counters,
                    )?;
                }
                let length = catalog.read_frame(
                    &mut storage,
                    due.track_index as usize,
                    due.index,
                    &mut opus_buffer,
                )?;
                let opus = if due.paused {
                    protocol::SILENCE
                } else {
                    &opus_buffer[..length]
                };
                peer.audio(due.pts_ms, opus)?;
                if !due.paused {
                    analysis.submit(due, opus, now)?;
                }
                if due.paused && due.spectrum {
                    send_data(
                        &mut peer,
                        Stream::Spectrum,
                        &protocol::spectrum(due, &[0; 32]),
                        &mut counters,
                    )?;
                }
            }
            if let Some(output) = analysis.latest(player.epoch(), platform::now_us()) {
                send_data(
                    &mut peer,
                    Stream::Spectrum,
                    &protocol::spectrum(output.tag.due, &output.bands),
                    &mut counters,
                )?;
            }
            if now >= next_telemetry && emitted {
                next_telemetry = now + 500_000;
                counters.sequence = counters.sequence.wrapping_add(1);
                send_json(
                    &mut peer,
                    &NowPlayingMessage {
                        event: "nowPlaying",
                        now_playing: &published.now_playing,
                    },
                    &mut json_buffer,
                    &mut counters,
                )?;
                let reading = metrics.latest(now);
                if now >= next_stack_sample {
                    stack_free = platform::stack_free();
                    next_stack_sample = now + 5_000_000;
                }
                let telemetry = Telemetry {
                    event: "telemetry",
                    firmware: "rust",
                    sequence: counters.sequence,
                    uptime_ms: now / 1000,
                    position_ms: published.position_ms,
                    duration_ms: published.duration_ms,
                    playback_revision: published.now_playing.revision,
                    music: protocol::MusicStatus {
                        cache_bytes: storage.cache_bytes() as u32,
                        index_bytes: catalog.index_bytes() as u32,
                        reads: storage.reads,
                        max_read_us: storage.max_read_us,
                    },
                    paused: player.paused(),
                    rssi: reading.and_then(|value| value.rssi),
                    hardware: reading.map(|value| value.hardware),
                    heap: reading
                        .map(|value| value.hardware.internal.free)
                        .unwrap_or_else(platform::heap_free),
                    // Audio send failures end this publisher session.
                    audio_errors: 0,
                    data_errors: counters.data,
                    skipped_frames: player.skipped_frames(),
                    rejected_commands: counters.rejected,
                    dropped_commands: peer.dropped(),
                    stack_free,
                    spectrum: analysis.status(),
                    led,
                };
                send_json(&mut peer, &telemetry, &mut json_buffer, &mut counters)?;
            }
            #[cfg(feature = "crypto-profile")]
            crypto_profile.tick(platform::now_us())?;
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn send_json(
    peer: &mut Peer,
    value: &impl serde::Serialize,
    buffer: &mut Vec<u8>,
    counters: &mut Counters,
) -> Result<()> {
    buffer.clear();
    serde_json::to_writer(&mut *buffer, value)
        .map_err(|_| Error::new("packet serialization failed"))?;
    send_data(peer, Stream::Robot, buffer, counters)
}

fn send_data(peer: &mut Peer, stream: Stream, bytes: &[u8], counters: &mut Counters) -> Result<()> {
    if peer.data(stream, bytes)? == SendOutcome::Backpressured {
        counters.data = counters.data.saturating_add(1);
    }
    Ok(())
}
