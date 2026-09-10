use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use tokio::{
    sync::{Mutex, mpsc},
    time,
};
use webrtc::{
    api::{
        APIBuilder,
        interceptor_registry::{configure_twcc_sender_only, register_default_interceptors},
        media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS, MediaEngine},
    },
    data_channel::{
        RTCDataChannel, data_channel_init::RTCDataChannelInit,
        data_channel_message::DataChannelMessage,
    },
    ice_transport::{ice_gathering_state::RTCIceGatheringState, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    media::Sample,
    peer_connection::{
        RTCPeerConnection, configuration::RTCConfiguration,
        sdp::session_description::RTCSessionDescription,
    },
    rtcp::{
        payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        },
        transport_feedbacks::transport_layer_cc::{
            PacketStatusChunk, SymbolTypeTcc, TransportLayerCc,
        },
    },
    rtp_transceiver::{
        RTCPFeedback, RTCRtpTransceiverInit,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
        rtp_transceiver_direction::RTCRtpTransceiverDirection,
    },
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
};

const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(15);

use crate::{
    input::{InputEvent, InputIngress, InputLane},
    media::VideoControl,
    signalling::{InputKind, PublisherInputChannel, PublisherInputs},
};

struct InputChannels {
    keyboard: Arc<RTCDataChannel>,
    pointer: Arc<RTCDataChannel>,
}

#[derive(Default)]
struct InputAuthorization {
    generation: AtomicU64,
}

impl InputAuthorization {
    fn allows(&self, generation: u64) -> bool {
        let active = self.generation.load(Ordering::Acquire);
        active != 0 && active == generation
    }

    fn set(&self, generation: Option<u64>) {
        self.generation
            .store(generation.unwrap_or(0), Ordering::Release);
    }
}

pub struct LocalOffer {
    pub sdp: String,
    pub audio_mid: String,
    pub video_mid: String,
}

pub struct PublisherPeer {
    connection: Arc<RTCPeerConnection>,
    audio_track: Arc<TrackLocalStaticSample>,
    pub audio_track_name: String,
    video_track: Arc<TrackLocalStaticSample>,
    pub video_track_name: String,
    transport_channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    input_channels: Mutex<Option<InputChannels>>,
    input_authorization: Arc<InputAuthorization>,
}

impl PublisherPeer {
    pub async fn create(
        video_control: Arc<VideoControl>,
        min_video_bitrate: u32,
        max_video_bitrate: u32,
    ) -> Result<Self> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_OPUS.to_owned(),
                        clock_rate: 48_000,
                        channels: 2,
                        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                        rtcp_feedback: Vec::new(),
                    },
                    payload_type: 111,
                    ..Default::default()
                },
                RTPCodecType::Audio,
            )
            .context("register Opus WebRTC codec")?;
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: MIME_TYPE_H264.to_owned(),
                        clock_rate: 90_000,
                        channels: 0,
                        sdp_fmtp_line:
                            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                                .to_owned(),
                        rtcp_feedback: vec![
                            RTCPFeedback {
                                typ: "goog-remb".to_owned(),
                                parameter: String::new(),
                            },
                            RTCPFeedback {
                                typ: "ccm".to_owned(),
                                parameter: "fir".to_owned(),
                            },
                            RTCPFeedback {
                                typ: "nack".to_owned(),
                                parameter: String::new(),
                            },
                            RTCPFeedback {
                                typ: "nack".to_owned(),
                                parameter: "pli".to_owned(),
                            },
                        ],
                    },
                    payload_type: 125,
                    ..Default::default()
                },
                RTPCodecType::Video,
            )
            .context("register H.264 WebRTC codec")?;
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .context("register WebRTC interceptors")?;
        let registry = configure_twcc_sender_only(registry, &mut media_engine)
            .context("configure outbound transport-wide congestion control")?;
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();
        let connection = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: vec![RTCIceServer {
                    urls: vec!["stun:stun.cloudflare.com:3478".to_owned()],
                    ..Default::default()
                }],
                ..Default::default()
            })
            .await
            .context("create WebRTC PeerConnection")?,
        );
        connection.on_ice_gathering_state_change(Box::new(move |state| {
            Box::pin(async move {
                tracing::info!(?state, "ICE gathering state changed");
            })
        }));
        let transport_channel = Arc::new(Mutex::new(None));
        let retained_transport = Arc::clone(&transport_channel);
        connection.on_data_channel(Box::new(move |channel| {
            let retained_transport = Arc::clone(&retained_transport);
            Box::pin(async move {
                let mut retained = retained_transport.lock().await;
                if retained.is_none() {
                    *retained = Some(channel);
                }
            })
        }));

        let audio_track_name = format!("audio-{}", uuid::Uuid::new_v4());
        let audio_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 2,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                ..Default::default()
            },
            audio_track_name.clone(),
            "freedoom-audio".to_owned(),
        ));
        connection
            .add_transceiver_from_track(
                audio_track.clone(),
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Sendonly,
                    send_encodings: Vec::new(),
                }),
            )
            .await
            .context("add send-only Opus transceiver")?;

        let video_track_name = format!("video-{}", uuid::Uuid::new_v4());
        let video_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90_000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_owned(),
                ..Default::default()
            },
            video_track_name.clone(),
            "freedoom-video".to_owned(),
        ));
        let video_transceiver = connection
            .add_transceiver_from_track(
                video_track.clone(),
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Sendonly,
                    send_encodings: Vec::new(),
                }),
            )
            .await
            .context("add send-only H.264 transceiver")?;
        Self::start_video_feedback_reader(
            video_transceiver.sender().await,
            video_control,
            min_video_bitrate,
            max_video_bitrate,
        );
        Ok(Self {
            connection,
            audio_track,
            audio_track_name,
            video_track,
            video_track_name,
            transport_channel,
            input_channels: Mutex::new(None),
            input_authorization: Arc::new(InputAuthorization::default()),
        })
    }

    pub async fn create_media_offer(&self) -> Result<LocalOffer> {
        let offer = self
            .connection
            .create_offer(None)
            .await
            .context("create Realtime SFU media offer")?;
        let gather_complete = self.connection.gathering_complete_promise().await;
        self.connection
            .set_local_description(offer)
            .await
            .context("set local Realtime SFU media offer")?;
        self.wait_for_ice_gathering(gather_complete, "media-offer")
            .await?;
        let description = self
            .connection
            .local_description()
            .await
            .context("read gathered Realtime SFU media offer")?;
        let transceivers = self.connection.get_transceivers().await;
        let audio_mid = transceivers
            .iter()
            .find(|transceiver| transceiver.kind().to_string() == "audio")
            .and_then(|transceiver| transceiver.mid())
            .context("find Opus transceiver MID")?
            .to_string();
        let video_mid = transceivers
            .iter()
            .find(|transceiver| transceiver.kind().to_string() == "video")
            .and_then(|transceiver| transceiver.mid())
            .context("find H.264 transceiver MID")?
            .to_string();
        Ok(LocalOffer {
            sdp: description.sdp,
            audio_mid,
            video_mid,
        })
    }

    pub async fn accept_media_answer(&self, answer_sdp: String) -> Result<()> {
        self.connection
            .set_remote_description(
                RTCSessionDescription::answer(answer_sdp)
                    .context("parse Realtime SFU media answer")?,
            )
            .await
            .context("set Realtime SFU media answer")
    }

    pub async fn answer_data_channel_offer(&self, offer_sdp: String) -> Result<String> {
        self.connection
            .set_remote_description(
                RTCSessionDescription::offer(offer_sdp)
                    .context("parse Realtime SFU DataChannel offer")?,
            )
            .await
            .context("set Realtime SFU DataChannel offer")?;
        let answer = self
            .connection
            .create_answer(None)
            .await
            .context("create Realtime SFU DataChannel answer")?;
        let answer_sdp = answer.sdp.clone();
        self.connection
            .set_local_description(answer)
            .await
            .context("set local Realtime SFU DataChannel answer")?;
        // This renegotiation reuses the established ICE transport.
        Ok(answer_sdp)
    }

    async fn wait_for_ice_gathering(
        &self,
        mut gather_complete: mpsc::Receiver<()>,
        phase: &'static str,
    ) -> Result<()> {
        let state = self.connection.ice_gathering_state();
        tracing::info!(phase, ?state, "checked ICE gathering state");
        if state == RTCIceGatheringState::Complete {
            return Ok(());
        }

        if time::timeout(ICE_GATHER_TIMEOUT, gather_complete.recv())
            .await
            .is_err()
        {
            let state = self.connection.ice_gathering_state();
            tracing::error!(
                phase,
                ?state,
                timeout_seconds = ICE_GATHER_TIMEOUT.as_secs(),
                "ICE gathering timed out"
            );
            bail!(
                "ICE gathering timed out during {phase} after {} seconds",
                ICE_GATHER_TIMEOUT.as_secs()
            );
        }

        let state = self.connection.ice_gathering_state();
        if state != RTCIceGatheringState::Complete {
            bail!("ICE gathering ended during {phase} with state {state}");
        }
        tracing::info!(phase, ?state, "ICE gathering completed");
        Ok(())
    }

    pub async fn create_input_channels(
        &self,
        inputs: &PublisherInputs,
        ingress: InputIngress,
    ) -> Result<()> {
        if self.input_channels.lock().await.is_some() {
            bail!("publisher input DataChannels already exist");
        }

        let mut staged = Vec::with_capacity(inputs.data_channels.len());
        for channel in &inputs.data_channels {
            match self.create_input_channel(channel, ingress.clone()).await {
                Ok(data_channel) => staged.push((channel.kind, data_channel)),
                Err(error) => {
                    let _ = close_channels(
                        staged
                            .into_iter()
                            .map(|(_, data_channel)| data_channel)
                            .collect(),
                    )
                    .await;
                    return Err(error);
                }
            }
        }

        let keyboard = take_input_channel(&mut staged, InputKind::Keyboard)?;
        let pointer = take_input_channel(&mut staged, InputKind::Pointer)?;
        *self.input_channels.lock().await = Some(InputChannels { keyboard, pointer });
        Ok(())
    }

    async fn create_input_channel(
        &self,
        channel: &PublisherInputChannel,
        ingress: InputIngress,
    ) -> Result<Arc<RTCDataChannel>> {
        let kind = channel.kind;
        let authorization = Arc::clone(&self.input_authorization);
        let data_channel = self
            .connection
            .create_data_channel(
                &channel.data_channel_name,
                Some(input_channel_init(kind, channel.id)),
            )
            .await
            .with_context(|| format!("create input DataChannel {}", channel.data_channel_name))?;
        data_channel.on_message(Box::new(move |message: DataChannelMessage| {
            let input = ingress.clone();
            let authorization = Arc::clone(&authorization);
            Box::pin(async move {
                if message.is_string {
                    tracing::warn!("discard text message on binary input DataChannel");
                    return;
                }
                let event = match InputEvent::decode(&message.data) {
                    Ok(event) => event,
                    Err(error) => {
                        tracing::warn!(%error, "discard malformed input DataChannel message");
                        return;
                    }
                };
                if !authorization.allows(event.generation()) {
                    tracing::debug!(
                        event_generation = event.generation(),
                        "discard input outside the active controller generation"
                    );
                    return;
                }
                let expected_lane = match kind {
                    InputKind::Keyboard => InputLane::Reliable,
                    InputKind::Pointer => InputLane::Pointer,
                };
                if event.lane() != expected_lane {
                    tracing::warn!(?kind, "discard input sent on the wrong reliability lane");
                    return;
                }
                match kind {
                    InputKind::Keyboard => {
                        if input.send_reliable(event).await.is_err() {
                            tracing::debug!("reliable input receiver closed");
                        }
                    }
                    InputKind::Pointer => input.send_pointer(event),
                }
            })
        }));
        Ok(data_channel)
    }

    pub fn set_controller_generation(&self, generation: Option<u64>) {
        self.input_authorization.set(generation);
    }

    pub async fn send_controller_ready(&self, viewer_id: &str, generation: u64) -> Result<()> {
        let channel = self
            .input_channels
            .lock()
            .await
            .as_ref()
            .map(|channels| Arc::clone(&channels.keyboard))
            .context("keyboard input DataChannel is unavailable")?;
        channel
            .send_text(controller_readiness_message(viewer_id, generation))
            .await
            .context("send controller readiness message")?;
        Ok(())
    }

    pub async fn close_input_channels(&self) -> Result<()> {
        let Some(channels) = self.input_channels.lock().await.take() else {
            return Ok(());
        };
        close_channels(vec![channels.keyboard, channels.pointer]).await
    }

    pub async fn write_video(&self, access_unit: Vec<u8>, frame_duration: Duration) -> Result<()> {
        self.video_track
            .write_sample(&Sample {
                data: Bytes::from(access_unit),
                duration: frame_duration,
                ..Default::default()
            })
            .await
            .context("send H.264 WebRTC sample")
    }

    pub async fn write_audio(&self, packet: Vec<u8>, duration: Duration) -> Result<()> {
        self.audio_track
            .write_sample(&Sample {
                data: Bytes::from(packet),
                duration,
                ..Default::default()
            })
            .await
            .context("send Opus WebRTC sample")
    }

    pub async fn close(&self) -> Result<()> {
        let mut errors = Vec::new();
        if let Err(error) = self.close_input_channels().await {
            errors.push(format!("close input DataChannels: {error:#}"));
        }
        if let Some(channel) = self.transport_channel.lock().await.take() {
            if let Err(error) = channel.close().await {
                errors.push(format!("close DataChannel transport: {error:#}"));
            }
        }
        if let Err(error) = self.connection.close().await {
            errors.push(format!("close WebRTC PeerConnection: {error:#}"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            bail!("{}", errors.join("; "))
        }
    }

    fn start_video_feedback_reader(
        sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
        video_control: Arc<VideoControl>,
        min_video_bitrate: u32,
        max_video_bitrate: u32,
    ) {
        tokio::spawn(async move {
            let mut last_adjustment = Instant::now() - Duration::from_secs(1);
            loop {
                let (packets, _) = match sender.read_rtcp().await {
                    Ok(packets) => packets,
                    Err(error) => {
                        tracing::debug!(%error, "stop video RTCP feedback reader");
                        return;
                    }
                };
                for packet in packets {
                    if packet.as_any().is::<PictureLossIndication>()
                        || packet.as_any().is::<FullIntraRequest>()
                    {
                        video_control.request_keyframe();
                        continue;
                    }
                    let Some(feedback) = packet.as_any().downcast_ref::<TransportLayerCc>() else {
                        continue;
                    };
                    let Some((received, total)) = transport_feedback_delivery(feedback) else {
                        continue;
                    };
                    let now = Instant::now();
                    if now.duration_since(last_adjustment) < Duration::from_millis(500) {
                        continue;
                    }
                    let current = video_control.target_bitrate();
                    let Some(target) = next_bitrate_target(
                        current,
                        min_video_bitrate,
                        max_video_bitrate,
                        received,
                        total,
                    ) else {
                        continue;
                    };
                    video_control.set_target_bitrate(target);
                    last_adjustment = now;
                    tracing::info!(
                        current,
                        target,
                        received,
                        total,
                        "adjusted H.264 bitrate from transport feedback"
                    );
                }
            }
        });
    }
}

fn input_channel_init(kind: InputKind, id: u16) -> RTCDataChannelInit {
    match kind {
        InputKind::Keyboard => RTCDataChannelInit {
            ordered: Some(true),
            negotiated: Some(id),
            ..Default::default()
        },
        InputKind::Pointer => RTCDataChannelInit {
            ordered: Some(false),
            max_retransmits: Some(0),
            negotiated: Some(id),
            ..Default::default()
        },
    }
}

fn controller_readiness_message(viewer_id: &str, generation: u64) -> String {
    serde_json::json!({
        "type": "controller-ready",
        "viewerId": viewer_id,
        "generation": generation,
    })
    .to_string()
}

fn take_input_channel(
    channels: &mut Vec<(InputKind, Arc<RTCDataChannel>)>,
    kind: InputKind,
) -> Result<Arc<RTCDataChannel>> {
    let index = channels
        .iter()
        .position(|(channel_kind, _)| *channel_kind == kind)
        .context("publisher input response omitted a required DataChannel")?;
    Ok(channels.swap_remove(index).1)
}

async fn close_channels(channels: Vec<Arc<RTCDataChannel>>) -> Result<()> {
    let mut errors = Vec::new();
    for channel in channels {
        if let Err(error) = channel.close().await {
            errors.push(error.to_string());
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        bail!("{}", errors.join("; "))
    }
}

fn transport_feedback_delivery(feedback: &TransportLayerCc) -> Option<(u16, u16)> {
    let mut total = 0_u16;
    let mut received = 0_u16;
    'chunks: for chunk in &feedback.packet_chunks {
        match chunk {
            PacketStatusChunk::RunLengthChunk(chunk) => {
                for _ in 0..chunk.run_length {
                    if total == feedback.packet_status_count {
                        break 'chunks;
                    }
                    total += 1;
                    if chunk.packet_status_symbol != SymbolTypeTcc::PacketNotReceived {
                        received += 1;
                    }
                }
            }
            PacketStatusChunk::StatusVectorChunk(chunk) => {
                for status in &chunk.symbol_list {
                    if total == feedback.packet_status_count {
                        break 'chunks;
                    }
                    total += 1;
                    if *status != SymbolTypeTcc::PacketNotReceived {
                        received += 1;
                    }
                }
            }
        }
    }
    (total == feedback.packet_status_count).then_some((received, total))
}

fn next_bitrate_target(
    current: u32,
    minimum: u32,
    maximum: u32,
    received: u16,
    total: u16,
) -> Option<u32> {
    if total < 20 {
        return None;
    }
    let lost = u32::from(total - received);
    let total = u32::from(total);
    let next = if lost * 100 >= total * 5 {
        current.saturating_mul(85) / 100
    } else if lost * 100 <= total {
        current.saturating_mul(105) / 100
    } else {
        return None;
    }
    .clamp(minimum, maximum);
    (next != current).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::{
        InputAuthorization, input_channel_init, next_bitrate_target, transport_feedback_delivery,
    };
    use crate::signalling::InputKind;
    use webrtc::rtcp::transport_feedbacks::transport_layer_cc::{
        PacketStatusChunk, RunLengthChunk, StatusChunkTypeTcc, SymbolTypeTcc, TransportLayerCc,
    };

    #[test]
    fn input_channels_use_the_required_reliability() {
        let keyboard = input_channel_init(InputKind::Keyboard, 4);
        assert_eq!(keyboard.ordered, Some(true));
        assert_eq!(keyboard.max_retransmits, None);
        assert_eq!(keyboard.negotiated, Some(4));

        let pointer = input_channel_init(InputKind::Pointer, 6);
        assert_eq!(pointer.ordered, Some(false));
        assert_eq!(pointer.max_retransmits, Some(0));
        assert_eq!(pointer.negotiated, Some(6));
    }

    #[test]
    fn controller_readiness_message_is_structured_and_generation_bound() {
        let message: serde_json::Value =
            serde_json::from_str(&super::controller_readiness_message("viewer-1", 17))
                .expect("decode readiness message");
        assert_eq!(
            message,
            serde_json::json!({
                "type": "controller-ready",
                "viewerId": "viewer-1",
                "generation": 17
            })
        );
    }

    #[test]
    fn input_authorization_requires_an_active_exact_generation() {
        let authorization = InputAuthorization::default();
        assert!(!authorization.allows(1));

        authorization.set(Some(4));
        assert!(authorization.allows(4));
        assert!(!authorization.allows(3));
        assert!(!authorization.allows(5));

        authorization.set(None);
        assert!(!authorization.allows(4));
    }

    #[test]
    fn transport_feedback_counts_lost_packets() {
        let feedback = TransportLayerCc {
            packet_status_count: 20,
            packet_chunks: vec![
                PacketStatusChunk::RunLengthChunk(RunLengthChunk {
                    type_tcc: StatusChunkTypeTcc::RunLengthChunk,
                    packet_status_symbol: SymbolTypeTcc::PacketNotReceived,
                    run_length: 2,
                }),
                PacketStatusChunk::RunLengthChunk(RunLengthChunk {
                    type_tcc: StatusChunkTypeTcc::RunLengthChunk,
                    packet_status_symbol: SymbolTypeTcc::PacketReceivedSmallDelta,
                    run_length: 18,
                }),
            ],
            ..Default::default()
        };
        assert_eq!(transport_feedback_delivery(&feedback), Some((18, 20)));
    }

    #[test]
    fn bitrate_target_reduces_on_loss_and_rises_when_clean() {
        assert_eq!(
            next_bitrate_target(4_000_000, 500_000, 4_000_000, 18, 20),
            Some(3_400_000)
        );
        assert_eq!(
            next_bitrate_target(3_000_000, 500_000, 4_000_000, 20, 20),
            Some(3_150_000)
        );
    }
}
