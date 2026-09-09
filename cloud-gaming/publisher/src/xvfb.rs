use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::sleep,
};
use uuid::Uuid;

use crate::config::Config;

pub struct XvfbServer {
    child: Child,
    display: String,
    runtime_dir: PathBuf,
}

impl XvfbServer {
    pub async fn start(config: &Config) -> Result<Self> {
        let runtime_root = config
            .runtime_dir
            .clone()
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("cloud-gaming-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&runtime_root)
            .await
            .context("create X11 session runtime directory")?;
        tokio::fs::set_permissions(&runtime_root, std::fs::Permissions::from_mode(0o700))
            .await
            .context("secure X11 session runtime directory")?;

        match Self::start_process(config, runtime_root.clone()).await {
            Ok(server) => Ok(server),
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&runtime_root).await;
                Err(error)
            }
        }
    }

    async fn start_process(config: &Config, runtime_dir: PathBuf) -> Result<Self> {
        let screen = format!("{}x{}x24", config.width, config.height);
        let mut child = Command::new("Xvfb")
            .kill_on_drop(true)
            .arg("-displayfd")
            .arg("1")
            .arg("-screen")
            .arg("0")
            .arg(screen)
            .arg("-nolisten")
            .arg("tcp")
            .arg("+extension")
            .arg("MIT-SHM")
            .arg("+extension")
            .arg("XTEST")
            .arg("+iglx")
            .arg("-noreset")
            // Xvfb has no physical input device. All local processes run as
            // the same unprivileged container user and TCP listening is off.
            .arg("-ac")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("start Xvfb")?;

        let stdout = child.stdout.take().context("capture Xvfb display number")?;
        let mut lines = BufReader::new(stdout).lines();
        let display_number = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .context("wait for Xvfb display number")??
            .context("Xvfb exited before reporting a display number")?;
        let display_number = display_number
            .trim()
            .parse::<u16>()
            .context("parse Xvfb display number")?;
        let display = format!(":{display_number}");

        Self::wait_for_display(&display).await?;
        Ok(Self {
            child,
            display,
            runtime_dir,
        })
    }

    pub fn display(&self) -> &str {
        &self.display
    }

    pub fn runtime_dir(&self) -> &PathBuf {
        &self.runtime_dir
    }

    pub async fn stop(mut self) -> Result<()> {
        if self.child.try_wait()?.is_none() {
            self.child.kill().await.context("stop Xvfb")?;
        }
        if tokio::fs::try_exists(&self.runtime_dir)
            .await
            .unwrap_or(true)
        {
            tokio::fs::remove_dir_all(&self.runtime_dir)
                .await
                .context("remove X11 session runtime directory")?;
        }
        Ok(())
    }

    async fn wait_for_display(display: &str) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let display = display.to_owned();
            let connected =
                tokio::task::spawn_blocking(move || x11rb::connect(Some(&display)).is_ok())
                    .await
                    .context("join Xvfb readiness probe")?;
            if connected {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("Xvfb did not accept X11 connections within five seconds");
            }
            sleep(Duration::from_millis(25)).await;
        }
    }
}

impl Drop for XvfbServer {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.start_kill();
        }
        let _ = std::fs::remove_dir_all(&self.runtime_dir);
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        config::test_config,
        input::InputEvent,
        x11::{ShmCapture, XtestInput},
    };

    use super::XvfbServer;

    #[tokio::test]
    async fn xvfb_supports_mit_shm_and_xtest() {
        let server = XvfbServer::start(&test_config()).await.expect("start Xvfb");
        let mut capture =
            ShmCapture::connect(server.display(), 2).expect("connect MIT-SHM capture");
        let buffer = capture
            .take_buffers()
            .pop()
            .expect("allocate MIT-SHM capture buffer");
        capture.capture(buffer).expect("capture Xvfb frame");

        let mut input = XtestInput::connect(server.display()).expect("connect XTEST input");
        input.advance_generation(1).expect("set trusted generation");
        input
            .apply(InputEvent::Motion {
                generation: 1,
                sequence: 1,
                delta_x: 1,
                delta_y: 1,
            })
            .expect("inject XTEST motion");
        input.release_all().expect("release XTEST state");
        server.stop().await.expect("stop Xvfb");
    }
}
