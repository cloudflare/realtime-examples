use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Child;

use crate::{
    config::{APPLICATION_IWAD, APPLICATION_PROGRAM, APPLICATION_TITLE},
    pulse::PulseAudioServer,
    xvfb::XvfbServer,
};

pub async fn start(xvfb: &XvfbServer, pulse: &PulseAudioServer) -> Result<Child> {
    let mut command = tokio::process::Command::new(APPLICATION_PROGRAM);
    command
        .kill_on_drop(true)
        .arg("-iwad")
        .arg(APPLICATION_IWAD)
        .env("DISPLAY", xvfb.display())
        .env("LIBGL_ALWAYS_SOFTWARE", "1")
        .env("SDL_AUDIODRIVER", "pulse")
        .env("SDL_VIDEODRIVER", "x11")
        // XTEST supplies core X11 pointer events rather than XInput2 raw motion.
        .env("SDL_MOUSE_RELATIVE_MODE_WARP", "1")
        .env("XDG_RUNTIME_DIR", xvfb.runtime_dir())
        .env("PULSE_SERVER", pulse.server_address())
        .env("PULSE_SINK", pulse.sink_name())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
        .spawn()
        .with_context(|| format!("start {APPLICATION_TITLE} with {APPLICATION_PROGRAM}"))
}

pub async fn stop(application: &mut Child) -> Result<()> {
    match application.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => application.kill().await.context("kill Freedoom"),
        Err(error) => {
            let _ = application.start_kill();
            Err(error).context("inspect Freedoom process")
        }
    }
}
