use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use anyhow::{Result, bail};
use tokio::{process::Child, task::JoinSet};

use crate::{
    game,
    media::{AudioPipeline, VideoPipeline},
    peer::PublisherPeer,
    pulse::PulseAudioServer,
    signalling::SignallingClient,
    x11::XtestInput,
    xvfb::XvfbServer,
};

pub struct RuntimeResources {
    pub signalling: SignallingClient,
    pub stop_needed: bool,
    pub running: Arc<AtomicBool>,
    pub xvfb: Option<XvfbServer>,
    pub pulse: Option<PulseAudioServer>,
    pub input: Option<XtestInput>,
    pub peer: Option<Arc<PublisherPeer>>,
    pub application: Option<Child>,
    pub video_pipeline: Option<VideoPipeline>,
    pub audio_pipeline: Option<AudioPipeline>,
    pub tasks: JoinSet<Result<()>>,
}

impl RuntimeResources {
    pub fn new(signalling: SignallingClient) -> Self {
        Self {
            signalling,
            stop_needed: false,
            running: Arc::new(AtomicBool::new(true)),
            xvfb: None,
            pulse: None,
            input: None,
            peer: None,
            application: None,
            video_pipeline: None,
            audio_pipeline: None,
            tasks: JoinSet::new(),
        }
    }

    pub async fn cleanup(&mut self, run_result: &Result<()>) -> Result<()> {
        self.running.store(false, Ordering::Release);
        let mut errors = Vec::new();

        if let Some(input) = self.input.as_mut() {
            record(&mut errors, "release held input", input.release_all());
        }
        if let Some(peer) = &self.peer {
            record(
                &mut errors,
                "close controller DataChannels",
                peer.close_input_channels().await,
            );
        }

        self.tasks.abort_all();
        while let Some(task) = self.tasks.join_next().await {
            if let Err(error) = task {
                if !error.is_cancelled() {
                    errors.push(format!("join publisher background task: {error}"));
                }
            }
        }

        if let Some(application) = self.application.as_mut() {
            record(&mut errors, "stop Freedoom", game::stop(application).await);
        }

        if let Some(pipeline) = self.video_pipeline.take() {
            match tokio::task::spawn_blocking(move || pipeline.stop()).await {
                Ok(result) => record(&mut errors, "stop H.264 pipeline", result),
                Err(error) => errors.push(format!("join H.264 cleanup task: {error}")),
            }
        }
        if let Some(pipeline) = self.audio_pipeline.take() {
            match tokio::task::spawn_blocking(move || pipeline.stop()).await {
                Ok(result) => record(&mut errors, "stop Opus pipeline", result),
                Err(error) => errors.push(format!("join Opus cleanup task: {error}")),
            }
        }

        if let Some(peer) = self.peer.take() {
            record(&mut errors, "close WebRTC peer", peer.close().await);
        }
        if run_result.is_ok() && self.stop_needed {
            record(
                &mut errors,
                "stop backend publisher state",
                self.signalling.stop().await,
            );
        }
        if let Some(pulse) = self.pulse.take() {
            record(&mut errors, "stop PulseAudio", pulse.stop().await);
        }
        if let Some(xvfb) = self.xvfb.take() {
            record(&mut errors, "stop Xvfb", xvfb.stop().await);
        }

        if errors.is_empty() {
            Ok(())
        } else {
            bail!("{}", errors.join("; "))
        }
    }
}

fn record(errors: &mut Vec<String>, operation: &str, result: Result<()>) {
    if let Err(error) = result {
        errors.push(format!("{operation}: {error:#}"));
    }
}
