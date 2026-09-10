use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{self, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use ffmpeg_next::{
    ChannelLayout, Dictionary, Packet, Rational,
    codec::{self, encoder},
    ffi,
    format::{Pixel, Sample, sample::Type as SampleType},
    frame, picture,
    software::scaling::{context::Context as ScalingContext, flag::Flags as ScalingFlags},
};
use tokio::sync::mpsc as tokio_mpsc;

use crate::pulse::{AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, PulseMonitor};
use crate::x11::{CaptureBuffer, FrameFormat, ShmCapture};

const H264_SLICE_MAX_SIZE: usize = 1_100;
const MIN_VBV_BUFFER_MILLIS: u64 = 250;
const OUTPUT_QUEUE_DEPTH: usize = 1;
const OPUS_FRAME_SAMPLES: usize = 960;
const OPUS_FRAME_DURATION: Duration = Duration::from_millis(20);
const PULSE_BYTES_PER_SAMPLE: usize = std::mem::size_of::<i16>();
const PULSE_FRAME_BYTES: usize =
    OPUS_FRAME_SAMPLES * AUDIO_CHANNELS as usize * PULSE_BYTES_PER_SAMPLE;
#[cfg(test)]
const RTP_OUTBOUND_MTU: usize = 1_200;
#[cfg(test)]
const RTP_HEADER_AND_TWCC_BYTES: usize = 20;

pub struct VideoControl {
    keyframe_requested: AtomicBool,
    target_bitrate: AtomicU32,
}

impl VideoControl {
    pub fn new(initial_bitrate: u32) -> Self {
        Self {
            keyframe_requested: AtomicBool::new(true),
            target_bitrate: AtomicU32::new(initial_bitrate),
        }
    }

    pub fn request_keyframe(&self) {
        self.keyframe_requested.store(true, Ordering::Release);
    }

    pub fn take_keyframe_request(&self) -> bool {
        self.keyframe_requested.swap(false, Ordering::AcqRel)
    }

    pub fn target_bitrate(&self) -> u32 {
        self.target_bitrate.load(Ordering::Acquire)
    }

    pub fn set_target_bitrate(&self, bitrate: u32) {
        self.target_bitrate.store(bitrate, Ordering::Release);
    }
}

pub struct EncodedAccessUnit {
    pub data: Vec<u8>,
    pub duration: Duration,
}

pub struct EncodedAudioPacket {
    pub data: Vec<u8>,
    pub duration: Duration,
}

pub struct AudioPipeline {
    output: Option<tokio_mpsc::Receiver<Result<EncodedAudioPacket, String>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl AudioPipeline {
    pub fn start(capture: PulseMonitor, bit_rate: u32, running: Arc<AtomicBool>) -> Result<Self> {
        let (output_tx, output_rx) = tokio_mpsc::channel(OUTPUT_QUEUE_DEPTH);
        let worker = thread::Builder::new()
            .name("opus-encode".to_owned())
            .spawn(move || {
                let mut encoder = match OpusEncoder::new(bit_rate) {
                    Ok(encoder) => encoder,
                    Err(error) => {
                        report_pipeline_error(&output_tx, &running, error);
                        return;
                    }
                };
                let mut pcm = vec![0_u8; PULSE_FRAME_BYTES];
                while running.load(Ordering::Acquire) {
                    if let Err(error) = capture.read(&mut pcm) {
                        report_pipeline_error(&output_tx, &running, error);
                        break;
                    }
                    if !running.load(Ordering::Acquire) {
                        break;
                    }
                    let packets = match encoder.encode(&pcm) {
                        Ok(packets) => packets,
                        Err(error) => {
                            report_pipeline_error(&output_tx, &running, error);
                            break;
                        }
                    };
                    for (index, packet) in packets.into_iter().enumerate() {
                        if output_tx
                            .blocking_send(Ok(EncodedAudioPacket {
                                data: packet,
                                duration: if index == 0 {
                                    OPUS_FRAME_DURATION
                                } else {
                                    Duration::ZERO
                                },
                            }))
                            .is_err()
                        {
                            running.store(false, Ordering::Release);
                            break;
                        }
                    }
                }
            })
            .context("start Opus encoder worker")?;
        Ok(Self {
            output: Some(output_rx),
            worker: Some(worker),
        })
    }

    pub fn take_output(
        &mut self,
    ) -> Result<tokio_mpsc::Receiver<Result<EncodedAudioPacket, String>>> {
        self.output
            .take()
            .context("Opus pipeline output was already taken")
    }

    pub fn stop(mut self) -> Result<()> {
        self.output.take();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("audio pipeline worker panicked"))?;
        }
        Ok(())
    }
}

pub struct OpusEncoder {
    source: frame::Audio,
    encoder: encoder::Audio,
    next_pts: i64,
}

impl OpusEncoder {
    pub fn new(bit_rate: u32) -> Result<Self> {
        let codec = encoder::find_by_name("libopus").context("libopus encoder is unavailable")?;
        let sample_format = Sample::I16(SampleType::Packed);
        codec
            .audio()
            .context("read libopus capabilities")?
            .formats()
            .is_some_and(|mut formats| formats.any(|format| format == sample_format))
            .then_some(())
            .context("libopus does not support interleaved s16 audio")?;
        let mut encoder = codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()
            .context("create Opus encoder context")?;
        encoder.set_rate(AUDIO_SAMPLE_RATE as i32);
        encoder.set_channel_layout(ChannelLayout::STEREO);
        encoder.set_format(sample_format);
        encoder.set_time_base(Rational(1, AUDIO_SAMPLE_RATE as i32));
        encoder.set_bit_rate(bit_rate as usize);
        let mut options = Dictionary::new();
        options.set("application", "lowdelay");
        let encoder = encoder.open_with(options).context("open libopus encoder")?;
        if encoder.frame_size() != OPUS_FRAME_SAMPLES as u32 {
            bail!(
                "libopus selected an unsupported frame size {}",
                encoder.frame_size()
            );
        }

        let source = frame::Audio::new(sample_format, OPUS_FRAME_SAMPLES, ChannelLayout::STEREO);
        Ok(Self {
            source,
            encoder,
            next_pts: 0,
        })
    }

    pub fn encode(&mut self, pcm: &[u8]) -> Result<Vec<Vec<u8>>> {
        if pcm.len() != PULSE_FRAME_BYTES {
            bail!("PulseAudio frame has an unexpected size");
        }
        self.source.data_mut(0)[..pcm.len()].copy_from_slice(pcm);
        self.source.set_rate(AUDIO_SAMPLE_RATE);
        self.source.set_pts(Some(self.next_pts));
        self.next_pts += OPUS_FRAME_SAMPLES as i64;
        self.encoder
            .send_frame(&self.source)
            .context("send frame to Opus encoder")?;

        let mut packets = Vec::new();
        let mut packet = Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            let data = packet.data().context("Opus packet has no payload")?;
            packets.push(data.to_vec());
        }
        Ok(packets)
    }
}

struct CapturedFrame {
    buffer: CaptureBuffer,
    duration: Duration,
}

struct LatestFrame<T> {
    value: Mutex<Option<T>>,
    ready: Condvar,
}

impl<T> LatestFrame<T> {
    fn new() -> Self {
        Self {
            value: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn publish(&self, value: T) {
        *self
            .value
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(value);
        self.ready.notify_one();
    }

    fn take_now(&self) -> Option<T> {
        self.value
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }

    fn receive_timeout(&self, timeout: Duration) -> Option<T> {
        let value = self
            .value
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let (mut value, _) = self
            .ready
            .wait_timeout_while(value, timeout, |value| value.is_none())
            .unwrap_or_else(|poison| poison.into_inner());
        value.take()
    }
}

pub struct VideoPipeline {
    output: Option<tokio_mpsc::Receiver<Result<EncodedAccessUnit, String>>>,
    workers: Vec<thread::JoinHandle<()>>,
}

impl VideoPipeline {
    pub fn start(
        mut capture: ShmCapture,
        fps: u8,
        initial_bitrate: u32,
        control: Arc<VideoControl>,
        running: Arc<AtomicBool>,
    ) -> Result<Self> {
        let format = capture.format();
        let buffers = capture.take_buffers();
        if buffers.len() < 2 {
            bail!("video pipeline requires at least two capture buffers");
        }
        let ring_size = buffers.len();
        let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps));
        let (free_tx, free_rx) = mpsc::sync_channel(ring_size);
        let captured: Arc<LatestFrame<CapturedFrame>> = Arc::new(LatestFrame::new());
        let (output_tx, output_rx) = tokio_mpsc::channel(OUTPUT_QUEUE_DEPTH);
        for buffer in buffers {
            free_tx
                .send(buffer)
                .map_err(|_| anyhow::anyhow!("initialize MIT-SHM capture ring"))?;
        }

        let capture_running = Arc::clone(&running);
        let capture_output = output_tx.clone();
        let capture_ready = Arc::clone(&captured);
        let capture_free_tx = free_tx.clone();
        let capture_worker = thread::Builder::new()
            .name("x11-capture".to_owned())
            .spawn(move || {
                let mut next_frame = Instant::now();
                while capture_running.load(Ordering::Acquire) {
                    let buffer = match free_rx.recv_timeout(Duration::from_millis(20)) {
                        Ok(buffer) => buffer,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => break,
                    };
                    let now = Instant::now();
                    if now < next_frame {
                        thread::sleep(next_frame - now);
                    }
                    next_frame += frame_duration;

                    let buffer = match capture.capture(buffer) {
                        Ok(buffer) => buffer,
                        Err(error) => {
                            report_pipeline_error(&capture_output, &capture_running, error);
                            break;
                        }
                    };
                    let mut frame = CapturedFrame {
                        buffer,
                        // Do not catch up after an overrun. Advance RTP timing
                        // over skipped capture intervals.
                        duration: capture_duration_after_overrun(
                            &mut next_frame,
                            frame_duration,
                            Instant::now(),
                        ),
                    };
                    if let Some(stale) = capture_ready.take_now() {
                        frame.duration += stale.duration;
                        if capture_free_tx.send(stale.buffer).is_err() {
                            break;
                        }
                    }
                    capture_ready.publish(frame);
                }
            })
            .context("start X11 capture worker")?;

        let encode_running = Arc::clone(&running);
        let encode_control = Arc::clone(&control);
        let encode_output = output_tx;
        let encode_ready = captured;
        let encode_worker = thread::Builder::new()
            .name("h264-encode".to_owned())
            .spawn(move || {
                let mut encoder = match H264Encoder::new(format, fps, initial_bitrate) {
                    Ok(encoder) => encoder,
                    Err(error) => {
                        report_pipeline_error(&encode_output, &encode_running, error);
                        return;
                    }
                };
                while encode_running.load(Ordering::Acquire) {
                    let frame = match encode_ready.receive_timeout(Duration::from_millis(20)) {
                        Some(frame) => frame,
                        None => continue,
                    };
                    let target_bitrate = encode_control.target_bitrate();
                    if target_bitrate != encoder.bit_rate() {
                        if let Err(error) = encoder.set_bit_rate(target_bitrate) {
                            report_pipeline_error(&encode_output, &encode_running, error);
                            break;
                        }
                        encoder.request_keyframe();
                        tracing::info!(
                            target_bitrate,
                            "reconfigured H.264 bitrate from transport feedback"
                        );
                    }
                    if encode_control.take_keyframe_request() {
                        encoder.request_keyframe();
                    }
                    let packets = match encoder.encode(frame.buffer.bytes(), format.stride) {
                        Ok(packets) => packets,
                        Err(error) => {
                            report_pipeline_error(&encode_output, &encode_running, error);
                            break;
                        }
                    };
                    for (index, packet) in packets.into_iter().enumerate() {
                        let access_unit = EncodedAccessUnit {
                            data: packet,
                            duration: if index == 0 {
                                frame.duration
                            } else {
                                Duration::ZERO
                            },
                        };
                        // H.264 P-frames depend on earlier access units. Only raw
                        // frames may be replaced; encoded output uses backpressure.
                        if encode_output.blocking_send(Ok(access_unit)).is_err() {
                            encode_running.store(false, Ordering::Release);
                            break;
                        }
                    }
                    if !encode_running.load(Ordering::Acquire) {
                        break;
                    }
                    if free_tx.send(frame.buffer).is_err() {
                        break;
                    }
                }
            })
            .context("start H.264 encoder worker")?;

        Ok(Self {
            output: Some(output_rx),
            workers: vec![capture_worker, encode_worker],
        })
    }

    pub fn take_output(
        &mut self,
    ) -> Result<tokio_mpsc::Receiver<Result<EncodedAccessUnit, String>>> {
        self.output
            .take()
            .context("H.264 pipeline output was already taken")
    }

    pub fn stop(mut self) -> Result<()> {
        self.output.take();
        for worker in self.workers.drain(..) {
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("video pipeline worker panicked"))?;
        }
        Ok(())
    }
}

fn report_pipeline_error<T>(
    output: &tokio_mpsc::Sender<Result<T, String>>,
    running: &AtomicBool,
    error: anyhow::Error,
) {
    running.store(false, Ordering::Release);
    let _ = output.blocking_send(Err(error.to_string()));
}

fn capture_duration_after_overrun(
    next_frame: &mut Instant,
    frame_duration: Duration,
    captured_at: Instant,
) -> Duration {
    let mut duration = frame_duration;
    while *next_frame <= captured_at {
        if *next_frame < captured_at {
            duration += frame_duration;
        }
        *next_frame += frame_duration;
    }
    duration
}

pub struct H264Encoder {
    source: frame::Video,
    yuv: frame::Video,
    scaler: ScalingContext,
    encoder: encoder::Video,
    format: FrameFormat,
    fps: u8,
    bit_rate: u32,
    next_pts: i64,
    keyframe_requested: bool,
}

impl H264Encoder {
    pub fn new(format: FrameFormat, fps: u8, bit_rate: u32) -> Result<Self> {
        if format.width % 2 != 0 || format.height % 2 != 0 {
            bail!("H.264 YUV420P requires an even viewport size");
        }
        let width = u32::from(format.width);
        let height = u32::from(format.height);
        let mut source = frame::Video::empty();
        source.set_format(Pixel::BGRZ);
        source.set_width(width);
        source.set_height(height);
        let yuv = frame::Video::new(Pixel::YUV420P, width, height);
        let scaler = ScalingContext::get(
            Pixel::BGRZ,
            width,
            height,
            Pixel::YUV420P,
            width,
            height,
            ScalingFlags::FAST_BILINEAR,
        )
        .context("create BGR0 to YUV420P scaler")?;
        let encoder = Self::open_encoder(format, fps, bit_rate)?;

        Ok(Self {
            source,
            yuv,
            scaler,
            encoder,
            format,
            fps,
            bit_rate,
            next_pts: 0,
            keyframe_requested: true,
        })
    }

    pub fn bit_rate(&self) -> u32 {
        self.bit_rate
    }

    pub fn set_bit_rate(&mut self, bit_rate: u32) -> Result<()> {
        if bit_rate == self.bit_rate {
            return Ok(());
        }
        self.encoder = Self::open_encoder(self.format, self.fps, bit_rate)?;
        self.bit_rate = bit_rate;
        Ok(())
    }

    pub fn request_keyframe(&mut self) {
        self.keyframe_requested = true;
    }

    pub fn encode(&mut self, bgr0: &[u8], source_stride: usize) -> Result<Vec<Vec<u8>>> {
        let expected_len = source_stride
            .checked_mul(usize::from(self.format.height))
            .context("captured frame length overflow")?;
        if bgr0.len() != expected_len || source_stride < usize::from(self.format.width) * 4 {
            bail!("captured frame has an unexpected layout");
        }
        self.set_external_bgr0(bgr0, source_stride)?;
        self.source.set_pts(Some(self.next_pts));
        self.next_pts += 1;
        self.scaler
            .run(&self.source, &mut self.yuv)
            .context("convert X11 frame to YUV420P")?;
        self.yuv.set_pts(self.source.pts());
        self.yuv
            .set_kind(if std::mem::take(&mut self.keyframe_requested) {
                picture::Type::I
            } else {
                picture::Type::None
            });
        self.encoder
            .send_frame(&self.yuv)
            .context("send frame to H.264 encoder")?;

        let mut packets = Vec::new();
        let mut packet = Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            let data = packet.data().context("H.264 packet has no payload")?;
            packets.push(data.to_vec());
        }
        Ok(packets)
    }

    fn open_encoder(format: FrameFormat, fps: u8, bit_rate: u32) -> Result<encoder::Video> {
        let width = u32::from(format.width);
        let height = u32::from(format.height);
        let codec = encoder::find_by_name("libx264").context("libx264 encoder is unavailable")?;
        let mut video = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .context("create H.264 encoder context")?;
        video.set_width(width);
        video.set_height(height);
        video.set_format(Pixel::YUV420P);
        video.set_time_base(Rational(1, i32::from(fps)));
        video.set_frame_rate(Some(Rational(i32::from(fps), 1)));
        // PLI/FIR normally drives recovery. This remains a bounded fallback.
        video.set_gop(u32::from(fps) * 3);
        video.set_max_b_frames(0);
        video.set_bit_rate(bit_rate as usize);

        let max_rate_kbps = bit_rate.div_ceil(1_000);
        let buffer_kbits = vbv_buffer_kbits(max_rate_kbps, fps);
        let mut options = Dictionary::new();
        options.set("preset", "ultrafast");
        options.set("tune", "zerolatency");
        options.set("profile", "baseline");
        options.set("repeat-headers", "1");
        options.set("forced-idr", "1");
        options.set(
            "x264-params",
            &format!(
                "vbv-maxrate={max_rate_kbps}:vbv-bufsize={buffer_kbits}:slice-max-size={H264_SLICE_MAX_SIZE}"
            ),
        );
        video.open_with(options).context("open libx264 encoder")
    }

    fn set_external_bgr0(&mut self, bgr0: &[u8], source_stride: usize) -> Result<()> {
        let source = unsafe { self.source.as_mut_ptr() };
        let filled = unsafe {
            // The leased MIT-SHM buffer remains owned by this encoder until
            // swscale returns; libav never owns or frees it.
            ffi::av_image_fill_arrays(
                (*source).data.as_mut_ptr(),
                (*source).linesize.as_mut_ptr(),
                bgr0.as_ptr(),
                Pixel::BGRZ.into(),
                i32::from(self.format.width),
                i32::from(self.format.height),
                1,
            )
        };
        if filled < 0 {
            bail!("configure external BGR0 frame for swscale");
        }
        unsafe {
            (*source).linesize[0] = i32::try_from(source_stride)
                .context("X11 framebuffer stride exceeds libav range")?;
        }
        Ok(())
    }
}

fn vbv_buffer_kbits(max_rate_kbps: u32, fps: u8) -> u32 {
    let two_frame_kbits = (max_rate_kbps * 2).div_ceil(u32::from(fps));
    let recovery_kbits = (u64::from(max_rate_kbps) * MIN_VBV_BUFFER_MILLIS)
        .div_ceil(1_000)
        .try_into()
        .expect("H.264 VBV buffer fits in u32");
    two_frame_kbits.max(recovery_kbits)
}

#[cfg(test)]
mod tests {
    use std::{
        thread,
        time::{Duration, Instant},
    };

    use tokio::sync::mpsc as tokio_mpsc;

    use super::{
        EncodedAccessUnit, H264_SLICE_MAX_SIZE, H264Encoder, LatestFrame, OPUS_FRAME_SAMPLES,
        OpusEncoder, RTP_HEADER_AND_TWCC_BYTES, RTP_OUTBOUND_MTU, capture_duration_after_overrun,
        vbv_buffer_kbits,
    };
    use crate::x11::FrameFormat;

    #[test]
    fn encodes_a_bgr0_frame_as_h264() {
        ffmpeg_next::init().expect("initialize libav");
        let format = FrameFormat {
            width: 320,
            height: 240,
            stride: 320 * 4,
        };
        let mut encoder = H264Encoder::new(format, 30, 4_000_000).expect("create H.264 encoder");
        let input = vec![0_u8; format.stride * usize::from(format.height)];
        let packets = encoder
            .encode(&input, format.stride)
            .expect("encode H.264 frame");
        assert!(!packets.is_empty());
        assert!(packets[0].starts_with(&[0, 0, 0, 1]) || packets[0].starts_with(&[0, 0, 1]));
    }

    #[test]
    fn encodes_stereo_pcm_as_opus() {
        ffmpeg_next::init().expect("initialize libav");
        let mut encoder = OpusEncoder::new(96_000).expect("create Opus encoder");
        let pcm = vec![0_u8; OPUS_FRAME_SAMPLES * 2 * std::mem::size_of::<i16>()];
        let packets = encoder.encode(&pcm).expect("encode Opus frame");
        assert!(!packets.is_empty());
    }

    #[test]
    fn requested_keyframe_emits_an_idr_access_unit() {
        ffmpeg_next::init().expect("initialize libav");
        let format = FrameFormat {
            width: 320,
            height: 240,
            stride: 320 * 4,
        };
        let mut encoder = H264Encoder::new(format, 30, 4_000_000).expect("create H.264 encoder");
        let input = vec![0_u8; format.stride * usize::from(format.height)];
        let _ = encoder
            .encode(&input, format.stride)
            .expect("encode initial H.264 frame");
        encoder.request_keyframe();
        let packets = encoder
            .encode(&input, format.stride)
            .expect("encode requested H.264 keyframe");
        assert!(packets.iter().any(|packet| contains_idr(packet)));
    }

    #[test]
    fn skipped_capture_intervals_advance_rtp_duration() {
        let frame_duration = Duration::from_millis(16);
        let started = Instant::now();
        let mut next_frame = started + frame_duration;
        let duration = capture_duration_after_overrun(
            &mut next_frame,
            frame_duration,
            started + frame_duration * 3,
        );
        assert_eq!(duration, frame_duration * 3);
        assert_eq!(next_frame, started + frame_duration * 4);
    }

    #[test]
    fn latest_frame_mailbox_discards_stale_work() {
        let mailbox = LatestFrame::new();
        mailbox.publish(1_u8);
        assert_eq!(mailbox.take_now(), Some(1));
        mailbox.publish(2_u8);
        mailbox.publish(3_u8);
        assert_eq!(mailbox.take_now(), Some(3));
    }

    #[tokio::test]
    async fn stalled_web_rtc_writer_preserves_h264_dependency_order() {
        let (output_tx, mut output_rx) =
            tokio_mpsc::channel::<Result<EncodedAccessUnit, String>>(1);
        output_tx
            .send(Ok(EncodedAccessUnit {
                data: vec![1],
                duration: Duration::from_millis(16),
            }))
            .await
            .expect("queue first access unit");
        let sender = thread::spawn(move || {
            output_tx
                .blocking_send(Ok(EncodedAccessUnit {
                    data: vec![2],
                    duration: Duration::from_millis(16),
                }))
                .expect("queue dependent access unit");
        });

        let first = output_rx
            .recv()
            .await
            .expect("first access unit is available")
            .expect("first access unit is valid");
        let second = output_rx
            .recv()
            .await
            .expect("dependent access unit is available")
            .expect("dependent access unit is valid");
        sender.join().expect("output worker completes");
        assert_eq!(first.data, vec![1]);
        assert_eq!(second.data, vec![2]);
    }

    #[test]
    fn h264_slice_leaves_rtp_and_twcc_header_room() {
        assert!(H264_SLICE_MAX_SIZE <= RTP_OUTBOUND_MTU - RTP_HEADER_AND_TWCC_BYTES);
    }

    #[test]
    fn vbv_reserves_space_for_recovery_frames() {
        assert_eq!(vbv_buffer_kbits(4_000, 60), 1_000);
        assert_eq!(vbv_buffer_kbits(500, 60), 125);
        assert_eq!(vbv_buffer_kbits(1_000, 1), 2_000);
    }

    fn contains_idr(access_unit: &[u8]) -> bool {
        let mut index = 0;
        while index + 4 <= access_unit.len() {
            let start_code_len = if access_unit[index..].starts_with(&[0, 0, 0, 1]) {
                4
            } else if access_unit[index..].starts_with(&[0, 0, 1]) {
                3
            } else {
                index += 1;
                continue;
            };
            let nal_index = index + start_code_len;
            if nal_index < access_unit.len() && access_unit[nal_index] & 0x1f == 5 {
                return true;
            }
            index = nal_index + 1;
        }
        false
    }
}
