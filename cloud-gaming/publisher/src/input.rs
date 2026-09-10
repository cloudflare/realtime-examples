use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use tokio::sync::{Notify, mpsc};

pub const RELIABLE_INPUT_QUEUE_DEPTH: usize = 128;

const INPUT_TYPE_KEY: u8 = 1;
const INPUT_TYPE_BUTTON: u8 = 2;
const INPUT_TYPE_MOTION: u8 = 3;
const INPUT_TYPE_WHEEL: u8 = 4;
const INPUT_TYPE_RESET: u8 = 5;
const INPUT_TYPE_OWNERSHIP: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputLane {
    Reliable,
    Pointer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    Key {
        generation: u64,
        sequence: u64,
        keycode: u8,
        pressed: bool,
    },
    Button {
        generation: u64,
        sequence: u64,
        button: u8,
        pressed: bool,
    },
    Motion {
        generation: u64,
        sequence: u64,
        delta_x: i16,
        delta_y: i16,
    },
    Wheel {
        generation: u64,
        sequence: u64,
        delta_y: i8,
    },
    Reset {
        generation: u64,
        sequence: u64,
    },
    Ownership {
        generation: u64,
        sequence: u64,
        active: bool,
    },
}

impl InputEvent {
    /// Binary frame: `[type u8][generation u64 LE][sequence u64 LE][payload...]`.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 17 {
            bail!("input frame is too short");
        }
        let kind = bytes[0];
        let generation = u64::from_le_bytes(
            bytes[1..9]
                .try_into()
                .map_err(|_| anyhow::anyhow!("input generation is malformed"))?,
        );
        let sequence = u64::from_le_bytes(
            bytes[9..17]
                .try_into()
                .map_err(|_| anyhow::anyhow!("input sequence is malformed"))?,
        );
        let payload = &bytes[17..];
        match kind {
            INPUT_TYPE_KEY => {
                if payload.len() != 2 {
                    bail!("key input frame has invalid payload length");
                }
                if payload[0] < 8 {
                    bail!("X11 keycode must be at least 8");
                }
                Ok(Self::Key {
                    generation,
                    sequence,
                    keycode: payload[0],
                    pressed: decode_bool(payload[1], "key pressed state")?,
                })
            }
            INPUT_TYPE_BUTTON => {
                if payload.len() != 2 {
                    bail!("button input frame has invalid payload length");
                }
                if !(1..=9).contains(&payload[0]) {
                    bail!("X11 mouse button must be between 1 and 9");
                }
                Ok(Self::Button {
                    generation,
                    sequence,
                    button: payload[0],
                    pressed: decode_bool(payload[1], "button pressed state")?,
                })
            }
            INPUT_TYPE_MOTION => {
                if payload.len() != 4 {
                    bail!("motion input frame has invalid payload length");
                }
                Ok(Self::Motion {
                    generation,
                    sequence,
                    delta_x: i16::from_le_bytes(
                        payload[0..2]
                            .try_into()
                            .map_err(|_| anyhow::anyhow!("horizontal motion is malformed"))?,
                    ),
                    delta_y: i16::from_le_bytes(
                        payload[2..4]
                            .try_into()
                            .map_err(|_| anyhow::anyhow!("vertical motion is malformed"))?,
                    ),
                })
            }
            INPUT_TYPE_WHEEL => {
                if payload.len() != 1 {
                    bail!("wheel input frame has invalid payload length");
                }
                Ok(Self::Wheel {
                    generation,
                    sequence,
                    delta_y: payload[0] as i8,
                })
            }
            INPUT_TYPE_RESET => {
                if !payload.is_empty() {
                    bail!("reset input frame has invalid payload length");
                }
                Ok(Self::Reset {
                    generation,
                    sequence,
                })
            }
            INPUT_TYPE_OWNERSHIP => {
                if payload.len() != 1 {
                    bail!("ownership input frame has invalid payload length");
                }
                Ok(Self::Ownership {
                    generation,
                    sequence,
                    active: decode_bool(payload[0], "ownership state")?,
                })
            }
            _ => bail!("unknown input frame type {kind}"),
        }
    }

    pub fn generation(&self) -> u64 {
        match self {
            Self::Key { generation, .. }
            | Self::Button { generation, .. }
            | Self::Motion { generation, .. }
            | Self::Wheel { generation, .. }
            | Self::Reset { generation, .. }
            | Self::Ownership { generation, .. } => *generation,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::Key { sequence, .. }
            | Self::Button { sequence, .. }
            | Self::Motion { sequence, .. }
            | Self::Wheel { sequence, .. }
            | Self::Reset { sequence, .. }
            | Self::Ownership { sequence, .. } => *sequence,
        }
    }

    pub fn lane(&self) -> InputLane {
        match self {
            Self::Motion { .. } => InputLane::Pointer,
            Self::Key { .. }
            | Self::Button { .. }
            | Self::Wheel { .. }
            | Self::Reset { .. }
            | Self::Ownership { .. } => InputLane::Reliable,
        }
    }
}

fn decode_bool(value: u8, field: &str) -> Result<bool> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => bail!("{field} must be encoded as 0 or 1"),
    }
}

#[derive(Clone)]
pub struct InputIngress {
    reliable: mpsc::Sender<InputEvent>,
    pointer: Arc<PointerMailbox>,
}

pub struct InputReceiver {
    reliable: mpsc::Receiver<InputEvent>,
    pointer: Arc<PointerMailbox>,
}

pub fn input_channel() -> (InputIngress, InputReceiver) {
    let (reliable_tx, reliable_rx) = mpsc::channel(RELIABLE_INPUT_QUEUE_DEPTH);
    let pointer = Arc::new(PointerMailbox::default());
    (
        InputIngress {
            reliable: reliable_tx,
            pointer: Arc::clone(&pointer),
        },
        InputReceiver {
            reliable: reliable_rx,
            pointer,
        },
    )
}

impl InputIngress {
    pub async fn send_reliable(
        &self,
        event: InputEvent,
    ) -> std::result::Result<(), mpsc::error::SendError<InputEvent>> {
        self.reliable.send(event).await
    }

    pub fn send_pointer(&self, event: InputEvent) {
        self.pointer.publish(event);
    }
}

impl InputReceiver {
    pub async fn recv(&mut self) -> Option<InputEvent> {
        tokio::select! {
            biased;
            event = self.reliable.recv() => event,
            event = self.pointer.receive() => Some(event),
        }
    }

    pub fn clear(&mut self) {
        while self.reliable.try_recv().is_ok() {}
        self.pointer.clear();
    }
}

#[derive(Default)]
struct PointerMailbox {
    pending: Mutex<Option<InputEvent>>,
    ready: Notify,
}

impl PointerMailbox {
    fn publish(&self, event: InputEvent) {
        let InputEvent::Motion {
            generation,
            sequence,
            delta_x,
            delta_y,
        } = event
        else {
            tracing::warn!("discard non-motion input sent to the pointer mailbox");
            return;
        };
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let notify = pending.is_none();
        *pending = match pending.take() {
            Some(InputEvent::Motion {
                generation: queued_generation,
                sequence: queued_sequence,
                delta_x: queued_x,
                delta_y: queued_y,
            }) if queued_generation == generation && sequence > queued_sequence => {
                Some(InputEvent::Motion {
                    generation,
                    sequence,
                    delta_x: queued_x.saturating_add(delta_x),
                    delta_y: queued_y.saturating_add(delta_y),
                })
            }
            Some(
                queued @ InputEvent::Motion {
                    generation: queued_generation,
                    sequence: queued_sequence,
                    ..
                },
            ) if queued_generation > generation
                || (queued_generation == generation && queued_sequence >= sequence) =>
            {
                Some(queued)
            }
            _ => Some(InputEvent::Motion {
                generation,
                sequence,
                delta_x,
                delta_y,
            }),
        };
        drop(pending);
        if notify {
            self.ready.notify_one();
        }
    }

    async fn receive(&self) -> InputEvent {
        loop {
            let notified = self.ready.notified();
            if let Some(event) = self
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                return event;
            }
            notified.await;
        }
    }

    fn clear(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }
}

#[cfg(test)]
mod tests {
    use super::{InputEvent, InputLane, input_channel};

    #[test]
    fn decodes_reliable_and_pointer_frames() {
        let mut motion = vec![3];
        motion.extend_from_slice(&7_u64.to_le_bytes());
        motion.extend_from_slice(&42_u64.to_le_bytes());
        motion.extend_from_slice(&(-12_i16).to_le_bytes());
        motion.extend_from_slice(&8_i16.to_le_bytes());
        let motion = InputEvent::decode(&motion).expect("decode motion");
        assert_eq!(
            motion,
            InputEvent::Motion {
                generation: 7,
                sequence: 42,
                delta_x: -12,
                delta_y: 8,
            }
        );
        assert_eq!(motion.lane(), InputLane::Pointer);

        let mut ownership = vec![6];
        ownership.extend_from_slice(&3_u64.to_le_bytes());
        ownership.extend_from_slice(&4_u64.to_le_bytes());
        ownership.push(0);
        let ownership = InputEvent::decode(&ownership).expect("decode ownership");
        assert_eq!(
            ownership,
            InputEvent::Ownership {
                generation: 3,
                sequence: 4,
                active: false,
            }
        );
        assert_eq!(ownership.lane(), InputLane::Reliable);
    }

    #[test]
    fn rejects_ambiguous_boolean_payloads() {
        let mut key = vec![1];
        key.extend_from_slice(&1_u64.to_le_bytes());
        key.extend_from_slice(&2_u64.to_le_bytes());
        key.extend_from_slice(&[38, 2]);
        assert!(InputEvent::decode(&key).is_err());
    }

    #[tokio::test]
    async fn coalesces_pointer_motion_when_the_consumer_is_busy() {
        let (ingress, mut receiver) = input_channel();
        ingress.send_pointer(InputEvent::Motion {
            generation: 9,
            sequence: 1,
            delta_x: 5,
            delta_y: -3,
        });
        ingress.send_pointer(InputEvent::Motion {
            generation: 9,
            sequence: 2,
            delta_x: 7,
            delta_y: 1,
        });
        ingress.send_pointer(InputEvent::Motion {
            generation: 9,
            sequence: 1,
            delta_x: 100,
            delta_y: 100,
        });

        assert_eq!(
            receiver.recv().await.expect("receive pointer motion"),
            InputEvent::Motion {
                generation: 9,
                sequence: 2,
                delta_x: 12,
                delta_y: -2,
            }
        );
    }
}
