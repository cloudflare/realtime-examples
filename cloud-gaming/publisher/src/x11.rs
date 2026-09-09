use std::{collections::BTreeSet, fs::File, os::fd::OwnedFd};

use anyhow::{Context, Result, bail};
use memmap2::{MmapMut, MmapOptions};
use x11rb::{
    connection::Connection,
    protocol::{
        shm::{ConnectionExt as ShmConnectionExt, Seg},
        xproto::{
            self, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ImageFormat, KEY_PRESS_EVENT,
            KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
        },
        xtest::ConnectionExt as XtestConnectionExt,
    },
    rust_connection::RustConnection,
};

use crate::input::InputEvent;

#[derive(Debug, Clone, Copy)]
pub struct FrameFormat {
    pub width: u16,
    pub height: u16,
    pub stride: usize,
}

pub const CAPTURE_RING_SIZE: usize = 3;

pub struct CaptureBuffer {
    segment: Seg,
    mapping: MmapMut,
}

impl CaptureBuffer {
    pub fn bytes(&self) -> &[u8] {
        &self.mapping
    }
}

pub struct ShmCapture {
    connection: RustConnection,
    root: xproto::Window,
    segments: Vec<Seg>,
    buffers: Vec<CaptureBuffer>,
    format: FrameFormat,
}

impl ShmCapture {
    pub fn connect(display: &str, ring_size: usize) -> Result<Self> {
        if ring_size < 2 {
            bail!("MIT-SHM capture requires at least two buffers");
        }
        let (connection, screen_index) =
            x11rb::connect(Some(display)).context("connect capture X11 client")?;
        connection
            .shm_query_version()
            .context("query MIT-SHM")?
            .reply()
            .context("verify MIT-SHM")?;

        let (root, width, height, image_byte_order, pixmap_format, visual) = {
            let setup = connection.setup();
            let screen = setup
                .roots
                .get(screen_index)
                .context("X11 screen index is invalid")?;
            let pixmap_format = setup
                .pixmap_formats
                .iter()
                .find(|format| format.depth == screen.root_depth)
                .context("X11 server does not describe the root pixel format")?;
            let visual = screen
                .allowed_depths
                .iter()
                .flat_map(|depth| depth.visuals.iter())
                .find(|visual| visual.visual_id == screen.root_visual)
                .context("X11 root visual is unavailable")?;
            (
                screen.root,
                screen.width_in_pixels,
                screen.height_in_pixels,
                setup.image_byte_order,
                *pixmap_format,
                *visual,
            )
        };
        if pixmap_format.bits_per_pixel != 32 {
            bail!(
                "unsupported Xvfb root format: expected 32 bits per pixel, got {}",
                pixmap_format.bits_per_pixel
            );
        }
        if image_byte_order != xproto::ImageOrder::LSB_FIRST {
            bail!("only little-endian Xvfb BGR0 capture is currently supported");
        }
        if visual.red_mask != 0x00ff_0000
            || visual.green_mask != 0x0000_ff00
            || visual.blue_mask != 0x0000_00ff
        {
            bail!("only little-endian BGR0 Xvfb root visuals are currently supported");
        }

        let line_bits = usize::from(width)
            .checked_mul(usize::from(pixmap_format.bits_per_pixel))
            .context("framebuffer width overflow")?;
        let scanline_pad = usize::from(pixmap_format.scanline_pad);
        let stride = line_bits
            .div_ceil(scanline_pad)
            .checked_mul(scanline_pad / 8)
            .context("framebuffer stride overflow")?;
        let bytes = stride
            .checked_mul(usize::from(height))
            .context("framebuffer size overflow")?;
        let segment_size = u32::try_from(bytes).context("framebuffer is too large for MIT-SHM")?;
        let mut segments = Vec::with_capacity(ring_size);
        let mut buffers = Vec::with_capacity(ring_size);
        for _ in 0..ring_size {
            let segment = connection
                .generate_id()
                .context("allocate MIT-SHM segment ID")?;
            let reply = connection
                .shm_create_segment(segment, segment_size, false)
                .context("create MIT-SHM segment")?
                .reply()
                .context("receive MIT-SHM segment")?;
            let fd: OwnedFd = reply.shm_fd;
            let file = File::from(fd);
            let mapping = unsafe {
                // Xvfb allocated this exact-sized descriptor and writes only
                // while each synchronous shm_get_image request is in flight.
                MmapOptions::new().len(bytes).map_mut(&file)
            }
            .context("map MIT-SHM capture buffer")?;
            segments.push(segment);
            buffers.push(CaptureBuffer { segment, mapping });
        }

        Ok(Self {
            connection,
            root,
            segments,
            buffers,
            format: FrameFormat {
                width,
                height,
                stride,
            },
        })
    }

    pub fn format(&self) -> FrameFormat {
        self.format
    }

    pub fn take_buffers(&mut self) -> Vec<CaptureBuffer> {
        std::mem::take(&mut self.buffers)
    }

    pub fn capture(&mut self, buffer: CaptureBuffer) -> Result<CaptureBuffer> {
        if buffer.bytes().len() != self.format.stride * usize::from(self.format.height) {
            bail!("capture buffer does not match the X11 framebuffer size");
        }
        self.connection
            .shm_get_image(
                self.root,
                0,
                0,
                self.format.width,
                self.format.height,
                u32::MAX,
                ImageFormat::Z_PIXMAP.into(),
                buffer.segment,
                0,
            )
            .context("request MIT-SHM image")?
            .reply()
            .context("wait for MIT-SHM image")?;
        Ok(buffer)
    }
}

impl Drop for ShmCapture {
    fn drop(&mut self) {
        for segment in &self.segments {
            let _ = self.connection.shm_detach(*segment);
        }
        let _ = self.connection.flush();
    }
}

pub struct XtestInput {
    connection: RustConnection,
    root: xproto::Window,
    held_keys: BTreeSet<u8>,
    held_buttons: BTreeSet<u8>,
    generation: u64,
    last_reliable_sequence: u64,
    last_pointer_sequence: u64,
}

impl XtestInput {
    pub fn connect(display: &str) -> Result<Self> {
        let (connection, screen_index) =
            x11rb::connect(Some(display)).context("connect XTEST input client")?;
        connection
            .xtest_get_version(2, 2)
            .context("query XTEST")?
            .reply()
            .context("verify XTEST")?;
        let root = connection
            .setup()
            .roots
            .get(screen_index)
            .context("X11 screen index is invalid")?
            .root;
        Ok(Self {
            connection,
            root,
            held_keys: BTreeSet::new(),
            held_buttons: BTreeSet::new(),
            generation: 0,
            last_reliable_sequence: 0,
            last_pointer_sequence: 0,
        })
    }

    pub fn apply(&mut self, event: InputEvent) -> Result<()> {
        let generation = event.generation();
        if generation < self.generation {
            tracing::debug!(
                event_generation = generation,
                trusted_generation = self.generation,
                "discard stale input"
            );
            return Ok(());
        }
        if generation > self.generation {
            tracing::warn!(
                event_generation = generation,
                trusted_generation = self.generation,
                "reject input from an untrusted future generation"
            );
            return Ok(());
        }

        let sequence = event.sequence();
        let last_sequence = match event {
            InputEvent::Motion { .. } => &mut self.last_pointer_sequence,
            _ => &mut self.last_reliable_sequence,
        };
        if sequence <= *last_sequence {
            return Ok(());
        }
        *last_sequence = sequence;

        match event {
            InputEvent::Key {
                keycode, pressed, ..
            } => self.key(keycode, pressed)?,
            InputEvent::Button {
                button, pressed, ..
            } => self.button(button, pressed)?,
            InputEvent::Motion {
                delta_x, delta_y, ..
            } => self.motion(delta_x, delta_y)?,
            InputEvent::Wheel { delta_y, .. } => self.wheel(delta_y)?,
            InputEvent::Reset { .. } => self.release_all()?,
            InputEvent::Ownership { active, .. } => {
                if !active {
                    self.release_all()?;
                }
            }
        }
        self.connection.flush().context("flush XTEST input")?;
        Ok(())
    }

    pub fn advance_generation(&mut self, generation: u64) -> Result<()> {
        if generation < self.generation {
            bail!("trusted input generation moved backwards");
        }
        if generation == self.generation {
            return Ok(());
        }
        self.release_all()?;
        self.generation = generation;
        self.last_reliable_sequence = 0;
        self.last_pointer_sequence = 0;
        Ok(())
    }

    pub fn release_all(&mut self) -> Result<()> {
        for keycode in std::mem::take(&mut self.held_keys) {
            self.fake(KEY_RELEASE_EVENT, keycode, 0, 0)?;
        }
        for button in std::mem::take(&mut self.held_buttons) {
            self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)?;
        }
        self.connection.flush().context("flush XTEST reset")?;
        Ok(())
    }

    fn key(&mut self, keycode: u8, pressed: bool) -> Result<()> {
        if pressed {
            self.held_keys.insert(keycode);
            self.fake(KEY_PRESS_EVENT, keycode, 0, 0)
        } else {
            self.held_keys.remove(&keycode);
            self.fake(KEY_RELEASE_EVENT, keycode, 0, 0)
        }
    }

    fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        if !(1..=9).contains(&button) {
            bail!("X11 mouse button must be between 1 and 9");
        }
        if pressed {
            self.held_buttons.insert(button);
            self.fake(BUTTON_PRESS_EVENT, button, 0, 0)
        } else {
            self.held_buttons.remove(&button);
            self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)
        }
    }

    fn motion(&mut self, delta_x: i16, delta_y: i16) -> Result<()> {
        // Relative XTEST motion stays correct when Crispy Doom recenters the
        // pointer between browser events.
        self.fake(MOTION_NOTIFY_EVENT, 1, delta_x, delta_y)
    }

    fn wheel(&mut self, delta_y: i8) -> Result<()> {
        let button = if delta_y > 0 { 4 } else { 5 };
        for _ in 0..usize::from(delta_y.unsigned_abs()) {
            self.fake(BUTTON_PRESS_EVENT, button, 0, 0)?;
            self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)?;
        }
        Ok(())
    }

    fn fake(&self, event_type: u8, detail: u8, root_x: i16, root_y: i16) -> Result<()> {
        self.connection
            .xtest_fake_input(event_type, detail, 0, self.root, root_x, root_y, 0)
            .context("inject XTEST event")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use x11rb::{NONE, protocol::xproto::ConnectionExt};

    use crate::{config::test_config, input::InputEvent, xvfb::XvfbServer};

    use super::XtestInput;

    #[tokio::test]
    async fn motion_uses_the_pointer_position_after_the_game_recenters_it() {
        let server = XvfbServer::start(&test_config()).await.expect("start Xvfb");
        let mut input = XtestInput::connect(server.display()).expect("connect XTEST input");
        input.advance_generation(1).expect("set trusted generation");
        let center = (320, 240);
        let target = (327, 229);

        input
            .connection
            .warp_pointer(NONE, input.root, 0, 0, 0, 0, center.0, center.1)
            .expect("center pointer")
            .check()
            .expect("apply pointer centering");
        input
            .apply(InputEvent::Motion {
                generation: 1,
                sequence: 1,
                delta_x: 7,
                delta_y: -11,
            })
            .expect("inject first XTEST motion");

        input
            .connection
            .warp_pointer(NONE, input.root, 0, 0, 0, 0, center.0, center.1)
            .expect("simulate game pointer recentering")
            .check()
            .expect("apply game pointer recentering");
        input
            .apply(InputEvent::Motion {
                generation: 1,
                sequence: 2,
                delta_x: 7,
                delta_y: -11,
            })
            .expect("inject second XTEST motion");

        let pointer = input
            .connection
            .query_pointer(input.root)
            .expect("query pointer after motion")
            .reply()
            .expect("read pointer after motion");
        assert_eq!((pointer.root_x, pointer.root_y), target);

        server.stop().await.expect("stop Xvfb");
    }

    #[tokio::test]
    async fn message_generations_cannot_advance_trusted_input_state() {
        let server = XvfbServer::start(&test_config()).await.expect("start Xvfb");
        let mut input = XtestInput::connect(server.display()).expect("connect XTEST input");
        input.advance_generation(4).expect("set trusted generation");

        input
            .apply(InputEvent::Key {
                generation: 5,
                sequence: 1,
                keycode: 38,
                pressed: true,
            })
            .expect("reject future input without failing the publisher");

        assert_eq!(input.generation, 4);
        assert!(input.held_keys.is_empty());
        server.stop().await.expect("stop Xvfb");
    }

    #[tokio::test]
    async fn generation_changes_release_held_keys_and_buttons() {
        let server = XvfbServer::start(&test_config()).await.expect("start Xvfb");
        let mut input = XtestInput::connect(server.display()).expect("connect XTEST input");
        input.advance_generation(1).expect("set trusted generation");
        input
            .apply(InputEvent::Key {
                generation: 1,
                sequence: 1,
                keycode: 38,
                pressed: true,
            })
            .expect("hold key");
        input
            .apply(InputEvent::Button {
                generation: 1,
                sequence: 2,
                button: 1,
                pressed: true,
            })
            .expect("hold button");

        input.advance_generation(2).expect("advance generation");

        assert!(input.held_keys.is_empty());
        assert!(input.held_buttons.is_empty());
        server.stop().await.expect("stop Xvfb");
    }
}
