use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use tokio::{
    process::Child,
    sync::mpsc,
    task::JoinSet,
    time::{self, MissedTickBehavior},
};

use crate::{
    input::InputReceiver,
    media::{EncodedAccessUnit, EncodedAudioPacket},
    peer::PublisherPeer,
    signalling::{ControllerPoll, SignallingClient},
    x11::XtestInput,
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const CONTROLLER_POLL_INTERVAL: Duration = Duration::from_secs(1);
const CONTROLLER_POLL_QUEUE_DEPTH: usize = 1;
const MAX_CONSECUTIVE_SIGNAL_FAILURES: u8 = 3;

pub fn spawn_background_tasks(
    tasks: &mut JoinSet<Result<()>>,
    peer: &Arc<PublisherPeer>,
    signalling: &SignallingClient,
    video_output: mpsc::Receiver<Result<EncodedAccessUnit, String>>,
    audio_output: mpsc::Receiver<Result<EncodedAudioPacket, String>>,
) -> mpsc::Receiver<ControllerPoll> {
    let video_peer = Arc::clone(peer);
    tasks.spawn(async move {
        send_video(video_peer, video_output)
            .await
            .context("video sender failed")
    });

    let audio_peer = Arc::clone(peer);
    tasks.spawn(async move {
        send_audio(audio_peer, audio_output)
            .await
            .context("audio sender failed")
    });

    let heartbeat_signalling = signalling.clone();
    tasks.spawn(async move {
        heartbeat_loop(heartbeat_signalling)
            .await
            .context("heartbeat loop failed")
    });

    let (poll_tx, poll_rx) = mpsc::channel(CONTROLLER_POLL_QUEUE_DEPTH);
    let poll_signalling = signalling.clone();
    tasks.spawn(async move {
        controller_poll_loop(poll_signalling, poll_tx)
            .await
            .context("controller poll loop failed")
    });
    poll_rx
}

pub async fn supervise(
    application: &mut Child,
    input: &mut XtestInput,
    peer: &Arc<PublisherPeer>,
    mut input_receiver: InputReceiver,
    poll_rx: &mut mpsc::Receiver<ControllerPoll>,
    tasks: &mut JoinSet<Result<()>>,
) -> Result<()> {
    let mut controller = ControllerState::default();
    let application_status = application.wait();
    tokio::pin!(application_status);

    loop {
        tokio::select! {
            biased;
            task = tasks.join_next() => {
                match task {
                    Some(Ok(Ok(()))) => bail!("publisher background task stopped unexpectedly"),
                    Some(Ok(Err(error))) => return Err(error),
                    Some(Err(error)) => return Err(error).context("publisher background task panicked"),
                    None => bail!("all publisher background tasks stopped unexpectedly"),
                }
            }
            status = &mut application_status => {
                let status = status.context("wait for Freedoom process")?;
                bail!("Freedoom exited unexpectedly with {status}");
            }
            poll = poll_rx.recv() => {
                let poll = poll.context("controller poll channel closed")?;
                apply_controller_poll(
                    &poll,
                    &mut controller,
                    input,
                    peer,
                    &mut input_receiver,
                ).await?;
            }
            event = input_receiver.recv() => {
                let event = event.context("input channel closed")?;
                input.apply(event)?;
            }
        }
    }
}

async fn send_video(
    peer: Arc<PublisherPeer>,
    mut output: mpsc::Receiver<Result<EncodedAccessUnit, String>>,
) -> Result<()> {
    while let Some(access_unit) = output.recv().await {
        let access_unit = access_unit.map_err(anyhow::Error::msg)?;
        peer.write_video(access_unit.data, access_unit.duration)
            .await?;
    }
    bail!("H.264 pipeline stopped unexpectedly")
}

async fn send_audio(
    peer: Arc<PublisherPeer>,
    mut output: mpsc::Receiver<Result<EncodedAudioPacket, String>>,
) -> Result<()> {
    while let Some(packet) = output.recv().await {
        let packet = packet.map_err(anyhow::Error::msg)?;
        peer.write_audio(packet.data, packet.duration).await?;
    }
    bail!("Opus pipeline stopped unexpectedly")
}

async fn heartbeat_loop(signalling: SignallingClient) -> Result<()> {
    let mut interval = time::interval(HEARTBEAT_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut consecutive_failures = 0_u8;
    loop {
        interval.tick().await;
        match signalling.heartbeat().await {
            Ok(()) => consecutive_failures = 0,
            Err(error) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_SIGNAL_FAILURES {
                    return Err(error);
                }
                tracing::warn!(
                    %error,
                    consecutive_failures,
                    "publisher heartbeat failed; retrying"
                );
            }
        }
    }
}

async fn controller_poll_loop(
    signalling: SignallingClient,
    poll_tx: mpsc::Sender<ControllerPoll>,
) -> Result<()> {
    let mut interval = time::interval(CONTROLLER_POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut consecutive_failures = 0_u8;
    loop {
        interval.tick().await;
        let poll = match signalling.poll_controller().await {
            Ok(poll) => {
                consecutive_failures = 0;
                poll
            }
            Err(error) => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_SIGNAL_FAILURES {
                    return Err(error);
                }
                tracing::warn!(
                    %error,
                    consecutive_failures,
                    "controller poll failed; retrying"
                );
                continue;
            }
        };
        poll_tx
            .send(poll)
            .await
            .context("controller poll receiver closed")?;
    }
}

#[derive(Debug, Default)]
struct ControllerState {
    initialized: bool,
    generation: u64,
    viewer_id: Option<String>,
}

impl ControllerState {
    fn requires_transition(&self, poll: &ControllerPoll) -> Result<bool> {
        if !self.initialized {
            return Ok(true);
        }
        if poll.generation < self.generation {
            bail!("trusted controller generation moved backwards");
        }
        if poll.generation > self.generation {
            return Ok(true);
        }
        let polled_id = poll
            .controller
            .as_ref()
            .map(|controller| controller.id.as_str());
        if self.viewer_id.as_deref() != polled_id {
            bail!("trusted controller identity changed without a generation change");
        }
        Ok(false)
    }

    fn commit(&mut self, poll: &ControllerPoll) {
        self.initialized = true;
        self.generation = poll.generation;
        self.viewer_id = poll
            .controller
            .as_ref()
            .map(|controller| controller.id.clone());
    }
}

async fn apply_controller_poll(
    poll: &ControllerPoll,
    state: &mut ControllerState,
    input: &mut XtestInput,
    peer: &Arc<PublisherPeer>,
    input_receiver: &mut InputReceiver,
) -> Result<()> {
    let transition = match state.requires_transition(poll) {
        Ok(transition) => transition,
        Err(error) => {
            peer.set_controller_generation(None);
            input.release_all()?;
            input_receiver.clear();
            return Err(error);
        }
    };
    if !transition {
        return Ok(());
    }

    peer.set_controller_generation(None);
    input.release_all()?;
    input_receiver.clear();
    input.advance_generation(poll.generation)?;

    if let Some(controller) = &poll.controller {
        peer.set_controller_generation(Some(controller.generation));
        peer.send_controller_ready(&controller.id, controller.generation)
            .await
            .context("broadcast controller readiness")?;
        tracing::info!(
            viewer_id = %controller.id,
            generation = controller.generation,
            "adopted trusted controller generation"
        );
    } else {
        tracing::info!(
            generation = poll.generation,
            "released trusted controller generation"
        );
    }
    state.commit(poll);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ControllerState;
    use crate::signalling::{Controller, ControllerPoll};

    #[test]
    fn controller_identity_changes_require_a_new_trusted_generation() {
        let mut state = ControllerState::default();
        let initial = ControllerPoll {
            generation: 4,
            controller: Some(Controller {
                id: "control-a".to_owned(),
                generation: 4,
            }),
        };
        assert!(state.requires_transition(&initial).expect("initial poll"));
        state.commit(&initial);

        let replacement_without_generation = ControllerPoll {
            generation: 4,
            controller: Some(Controller {
                id: "control-b".to_owned(),
                generation: 4,
            }),
        };
        assert!(
            state
                .requires_transition(&replacement_without_generation)
                .is_err()
        );

        let replacement = ControllerPoll {
            generation: 5,
            controller: Some(Controller {
                id: "control-b".to_owned(),
                generation: 5,
            }),
        };
        assert!(
            state
                .requires_transition(&replacement)
                .expect("new generation")
        );
    }

    #[test]
    fn trusted_generations_cannot_move_backwards() {
        let mut state = ControllerState::default();
        let initial = ControllerPoll {
            generation: 8,
            controller: None,
        };
        state.commit(&initial);
        assert!(
            state
                .requires_transition(&ControllerPoll {
                    generation: 7,
                    controller: None,
                })
                .is_err()
        );
    }
}
