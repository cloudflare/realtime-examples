use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result};
use libpulse_binding::{sample, stream};
use libpulse_simple_binding::Simple;
use tokio::process::{Child, Command};
use tokio::time::{Duration, sleep};

pub const AUDIO_CHANNELS: u8 = 2;
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;
const SINK_NAME: &str = "game_audio";
const READY_TIMEOUT: Duration = Duration::from_secs(5);
const PULSE_COOKIE_BYTES: usize = 256;

pub struct PulseAudioServer {
    child: Child,
    config_path: PathBuf,
    socket_path: PathBuf,
}

pub struct PulseMonitor {
    stream: Simple,
}

impl PulseAudioServer {
    pub async fn start(runtime_dir: &Path) -> Result<Self> {
        let config_path = runtime_dir.join("pulse-daemon.conf");
        let socket_path = runtime_dir.join("pulse-native");
        let config_home = runtime_dir.join(".config");
        let pulse_config_dir = config_home.join("pulse");
        tokio::fs::create_dir_all(&pulse_config_dir)
            .await
            .context("create PulseAudio configuration directory")?;
        tokio::fs::set_permissions(&config_home, std::fs::Permissions::from_mode(0o700))
            .await
            .context("secure PulseAudio configuration directory")?;
        tokio::fs::set_permissions(&pulse_config_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .context("secure PulseAudio configuration subdirectory")?;
        let mut cookie = Vec::with_capacity(PULSE_COOKIE_BYTES);
        while cookie.len() < PULSE_COOKIE_BYTES {
            cookie.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
        }
        let cookie_path = pulse_config_dir.join("cookie");
        tokio::fs::write(&cookie_path, &cookie[..PULSE_COOKIE_BYTES])
            .await
            .context("write PulseAudio cookie")?;
        tokio::fs::set_permissions(&cookie_path, std::fs::Permissions::from_mode(0o600))
            .await
            .context("secure PulseAudio cookie")?;
        let config = format!(
            "load-module module-native-protocol-unix socket={} auth-anonymous=1\n\
             load-module module-null-sink sink_name={SINK_NAME} format=s16le rate={AUDIO_SAMPLE_RATE} channels={AUDIO_CHANNELS}\n\
             set-default-sink {SINK_NAME}\n",
            socket_path.display(),
        );
        tokio::fs::write(&config_path, config)
            .await
            .context("write PulseAudio session configuration")?;

        let mut child = Command::new("pulseaudio")
            .kill_on_drop(true)
            .arg("--daemonize=no")
            .arg("--high-priority=false")
            .arg("--realtime=false")
            .arg("--disallow-exit")
            .arg("--exit-idle-time=-1")
            .arg("--log-target=stderr")
            .arg("-n")
            .arg("-F")
            .arg(&config_path)
            .env("XDG_RUNTIME_DIR", runtime_dir)
            .env("XDG_CONFIG_HOME", config_home)
            .env("HOME", runtime_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start PulseAudio daemon")?;

        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        while tokio::fs::metadata(&socket_path).await.is_err() {
            if let Some(status) = child.try_wait().context("check PulseAudio daemon status")? {
                anyhow::bail!("PulseAudio daemon exited before opening its socket: {status}");
            }
            if tokio::time::Instant::now() >= deadline {
                anyhow::bail!("PulseAudio daemon did not open its socket within five seconds");
            }
            sleep(Duration::from_millis(25)).await;
        }

        Ok(Self {
            child,
            config_path,
            socket_path,
        })
    }

    pub fn server_address(&self) -> String {
        format!("unix:{}", self.socket_path.display())
    }

    pub fn sink_name(&self) -> &'static str {
        SINK_NAME
    }

    pub fn connect_monitor(&self) -> Result<PulseMonitor> {
        let sample_spec = sample::Spec {
            format: sample::Format::S16le,
            channels: AUDIO_CHANNELS,
            rate: AUDIO_SAMPLE_RATE,
        };
        assert!(sample_spec.is_valid());
        let server = self.server_address();
        let stream = Simple::new(
            Some(&server),
            "cloud-gaming-publisher",
            stream::Direction::Record,
            Some(&format!("{SINK_NAME}.monitor")),
            "Freedoom audio capture",
            &sample_spec,
            None,
            None,
        )
        .context("connect to PulseAudio null-sink monitor")?;
        Ok(PulseMonitor { stream })
    }

    pub async fn stop(mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill().await.context("stop PulseAudio daemon")?;
        }
        let _ = tokio::fs::remove_file(&self.config_path).await;
        Ok(())
    }
}

impl Drop for PulseAudioServer {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.start_kill();
        }
    }
}

impl PulseMonitor {
    pub fn read(&self, samples: &mut [u8]) -> Result<()> {
        self.stream
            .read(samples)
            .context("read PulseAudio null-sink monitor")
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use anyhow::{Context, Result};

    use super::PulseAudioServer;

    #[tokio::test]
    async fn starts_a_private_null_sink() -> Result<()> {
        if tokio::process::Command::new("pulseaudio")
            .arg("--version")
            .output()
            .await
            .is_err()
        {
            return Ok(());
        }
        let runtime_dir =
            std::env::temp_dir().join(format!("cloud-gaming-pulse-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&runtime_dir)
            .await
            .context("create PulseAudio test runtime directory")?;
        tokio::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .context("secure PulseAudio test runtime directory")?;
        let server = PulseAudioServer::start(&runtime_dir).await?;
        drop(server.connect_monitor()?);
        server.stop().await?;
        tokio::fs::remove_dir_all(&runtime_dir)
            .await
            .context("remove PulseAudio test runtime directory")?;
        Ok(())
    }
}
