use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::Parser;

pub const APPLICATION_TITLE: &str = "Freedoom";
pub const APPLICATION_PROGRAM: &str = "/usr/games/crispy-doom";
pub const APPLICATION_IWAD: &str = "/usr/share/games/doom/freedoom2.wad";

#[derive(Debug, Clone, Parser)]
#[command(about = "Publish Freedoom through Cloudflare Realtime SFU")]
pub struct Config {
    /// Opaque run identifier supplied by GameContainer.start().
    #[arg(long, env = "GAME_RUN_ID")]
    pub run_id: String,

    /// Monotonic run generation supplied by GameContainer.start().
    #[arg(long, env = "GAME_RUN_GENERATION")]
    pub run_generation: u64,

    /// X11 viewport width in pixels.
    #[arg(long, default_value_t = 800)]
    pub width: u16,

    /// X11 viewport height in pixels.
    #[arg(long, default_value_t = 600)]
    pub height: u16,

    /// Target capture frame rate.
    #[arg(long, default_value_t = 30)]
    pub fps: u8,

    /// Maximum H.264 bitrate in bits per second.
    #[arg(long, default_value_t = 4_000_000)]
    pub video_bitrate: u32,

    /// Lowest H.264 bitrate selected by transport feedback.
    #[arg(long, default_value_t = 500_000)]
    pub min_video_bitrate: u32,

    /// Opus bitrate in bits per second.
    #[arg(long, default_value_t = 96_000)]
    pub audio_bitrate: u32,

    /// Optional parent directory for X11 and PulseAudio runtime files.
    #[arg(long, env = "X11_SESSION_RUNTIME_DIR")]
    pub runtime_dir: Option<PathBuf>,
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.run_id.is_empty() || self.run_id.len() > 128 {
            bail!("GAME_RUN_ID must contain between 1 and 128 characters");
        }
        if !self
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            bail!("GAME_RUN_ID may contain only ASCII letters, digits, '.', '-', and '_'");
        }
        if self.run_generation == 0 {
            bail!("GAME_RUN_GENERATION must be greater than zero");
        }
        if self.width < 320 || self.height < 240 {
            bail!("viewport must be at least 320x240");
        }
        if self.width % 2 != 0 || self.height % 2 != 0 {
            bail!("viewport width and height must be even for H.264 YUV420P");
        }
        if self.fps == 0 || self.fps > 120 {
            bail!("--fps must be between 1 and 120");
        }
        if self.min_video_bitrate == 0 {
            bail!("--min-video-bitrate must be greater than zero");
        }
        if self.video_bitrate < self.min_video_bitrate {
            bail!("--video-bitrate must be at least --min-video-bitrate");
        }
        if !(6_000..=510_000).contains(&self.audio_bitrate) {
            bail!("--audio-bitrate must be between 6000 and 510000");
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_config() -> Config {
    Config {
        run_id: "run-123".to_owned(),
        run_generation: 7,
        width: 640,
        height: 480,
        fps: 30,
        video_bitrate: 4_000_000,
        min_video_bitrate: 500_000,
        audio_bitrate: 96_000,
        runtime_dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::test_config;

    #[test]
    fn accepts_a_bounded_path_safe_run_identity() {
        assert!(test_config().validate().is_ok());
    }

    #[test]
    fn rejects_run_identifiers_that_can_change_the_route() {
        for run_id in ["", "../other-run", "run/other", "run?query", "run space"] {
            let mut config = test_config();
            config.run_id = run_id.to_owned();
            assert!(config.validate().is_err(), "{run_id:?} must be rejected");
        }
    }

    #[test]
    fn rejects_zero_run_generation() {
        let mut config = test_config();
        config.run_generation = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_odd_yuv420p_viewport_dimensions() {
        let mut config = test_config();
        config.width = 641;
        assert!(config.validate().is_err());
        config.width = 640;
        config.height = 481;
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_unsupported_opus_bitrates() {
        let mut config = test_config();
        config.audio_bitrate = 5_999;
        assert!(config.validate().is_err());
        config.audio_bitrate = 510_001;
        assert!(config.validate().is_err());
    }
}
