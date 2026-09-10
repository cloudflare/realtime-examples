mod config;
mod game;
mod health;
mod input;
mod media;
mod peer;
mod pulse;
mod runtime;
mod signalling;
mod supervisor;
mod x11;
mod xvfb;

use std::{future::Future, process::ExitCode, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use clap::Parser;
use config::Config;
use media::{AudioPipeline, VideoPipeline};
use peer::PublisherPeer;
use runtime::RuntimeResources;
use signalling::{SignallingClient, Viewport};
use tokio::time;

const STARTUP_STEP_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();

    let config = Config::parse();
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "publisher terminated with an error");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: Config) -> Result<()> {
    config.validate()?;
    ffmpeg_next::init().context("initialize libav")?;
    let signalling = SignallingClient::new(config.run_id.clone(), config.run_generation)?;
    let mut resources = RuntimeResources::new(signalling);
    let result = {
        let publisher = run_publisher(&config, &mut resources);
        tokio::pin!(publisher);
        let shutdown = shutdown_signal();
        tokio::pin!(shutdown);
        tokio::select! {
            result = &mut publisher => result,
            signal = &mut shutdown => {
                let signal = signal?;
                tracing::info!(signal, "received publisher shutdown signal");
                Ok(())
            }
        }
    };
    let cleanup = resources.cleanup(&result).await;

    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(cleanup)) => Err(cleanup.context("publisher cleanup failed")),
        (Err(error), Err(cleanup)) => {
            bail!("{error:#}; publisher cleanup also failed: {cleanup:#}")
        }
    }
}

async fn run_publisher(config: &Config, resources: &mut RuntimeResources) -> Result<()> {
    resources
        .tasks
        .spawn(async { health::serve().await.context("health server failed") });
    resources.xvfb = Some(startup_step("xvfb", xvfb::XvfbServer::start(config)).await?);
    let runtime_dir = resources
        .xvfb
        .as_ref()
        .context("Xvfb resource missing after startup")?
        .runtime_dir()
        .clone();
    resources.pulse =
        Some(startup_step("pulseaudio", pulse::PulseAudioServer::start(&runtime_dir)).await?);

    let display = resources
        .xvfb
        .as_ref()
        .context("Xvfb resource missing after startup")?
        .display()
        .to_owned();
    let capture = x11::ShmCapture::connect(&display, x11::CAPTURE_RING_SIZE)?;
    resources.input = Some(x11::XtestInput::connect(&display)?);

    let video_control = Arc::new(media::VideoControl::new(config.video_bitrate));
    let peer = Arc::new(
        startup_step(
            "peer-connection",
            PublisherPeer::create(
                Arc::clone(&video_control),
                config.min_video_bitrate,
                config.video_bitrate,
            ),
        )
        .await?,
    );
    resources.peer = Some(Arc::clone(&peer));

    let viewport = Viewport {
        width: config.width,
        height: config.height,
        fps: config.fps,
    };
    // Registration is path-idempotent on run ID and generation. Once the
    // request is attempted, cleanup always asks the backend to stop that path.
    resources.stop_needed = true;
    let registered = startup_step(
        "publisher-registration",
        resources.signalling.register_session(&viewport),
    )
    .await
    .context("register publisher session")?;
    tracing::info!(
        run_id = %config.run_id,
        run_generation = config.run_generation,
        sfu_session_id = %registered.session_id,
        width = viewport.width,
        height = viewport.height,
        fps = viewport.fps,
        "registered Freedoom publisher"
    );

    let media_offer = startup_step("media-offer", peer.create_media_offer()).await?;
    let published = startup_step(
        "media-publish",
        resources.signalling.publish(
            &media_offer.sdp,
            &media_offer.video_mid,
            &peer.video_track_name,
            &media_offer.audio_mid,
            &peer.audio_track_name,
        ),
    )
    .await
    .context("publish H.264 and Opus tracks")?;
    startup_step(
        "media-answer",
        peer.accept_media_answer(published.session_description.sdp),
    )
    .await?;

    let established = startup_step(
        "datachannel-establish",
        resources.signalling.establish_data_channels(),
    )
    .await
    .context("establish DataChannel transport")?;
    let data_channel_answer = startup_step(
        "datachannel-answer",
        peer.answer_data_channel_offer(established.session_description.sdp),
    )
    .await?;
    let inputs = startup_step(
        "datachannel-complete",
        resources
            .signalling
            .complete_data_channels(&data_channel_answer),
    )
    .await
    .context("complete publisher DataChannel transport")?;
    let (input_ingress, input_receiver) = input::input_channel();
    startup_step(
        "input-channels",
        peer.create_input_channels(&inputs, input_ingress),
    )
    .await?;

    let xvfb = resources
        .xvfb
        .as_ref()
        .context("Xvfb resource missing before game startup")?;
    let pulse = resources
        .pulse
        .as_ref()
        .context("PulseAudio resource missing before game startup")?;
    resources.application = Some(startup_step("freedoom", game::start(xvfb, pulse)).await?);

    let audio_capture = pulse.connect_monitor()?;
    resources.video_pipeline = Some(VideoPipeline::start(
        capture,
        config.fps,
        config.video_bitrate,
        video_control,
        Arc::clone(&resources.running),
    )?);
    resources.audio_pipeline = Some(AudioPipeline::start(
        audio_capture,
        config.audio_bitrate,
        Arc::clone(&resources.running),
    )?);
    tracing::info!("publisher media pipelines started");

    let video_output = resources
        .video_pipeline
        .as_mut()
        .context("video pipeline missing after startup")?
        .take_output()?;
    let audio_output = resources
        .audio_pipeline
        .as_mut()
        .context("audio pipeline missing after startup")?
        .take_output()?;
    let mut poll_rx = supervisor::spawn_background_tasks(
        &mut resources.tasks,
        &peer,
        &resources.signalling,
        video_output,
        audio_output,
    );

    supervisor::supervise(
        resources
            .application
            .as_mut()
            .context("Freedoom process missing after startup")?,
        resources
            .input
            .as_mut()
            .context("XTEST input missing after startup")?,
        &peer,
        input_receiver,
        &mut poll_rx,
        &mut resources.tasks,
    )
    .await
}

async fn startup_step<T>(
    phase: &'static str,
    operation: impl Future<Output = Result<T>>,
) -> Result<T> {
    tracing::info!(phase, "publisher startup phase started");
    match time::timeout(STARTUP_STEP_TIMEOUT, operation).await {
        Ok(Ok(value)) => {
            tracing::info!(phase, "publisher startup phase completed");
            Ok(value)
        }
        Ok(Err(error)) => {
            tracing::error!(
                phase,
                error = %format!("{error:#}"),
                "publisher startup phase failed"
            );
            Err(error)
        }
        Err(_) => {
            tracing::error!(
                phase,
                timeout_seconds = STARTUP_STEP_TIMEOUT.as_secs(),
                "publisher startup phase timed out"
            );
            bail!(
                "publisher startup phase {phase} timed out after {} seconds",
                STARTUP_STEP_TIMEOUT.as_secs()
            )
        }
    }
}

async fn shutdown_signal() -> Result<&'static str> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("install SIGTERM handler")?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            result.context("wait for SIGINT")?;
            Ok("SIGINT")
        }
        signal = terminate.recv() => {
            signal.context("SIGTERM handler closed")?;
            Ok("SIGTERM")
        }
    }
}
