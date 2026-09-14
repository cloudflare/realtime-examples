//! Small diagnostic errors: no request bodies, credentials, or SDP in messages.
use std::fmt;

#[derive(Debug, Clone, Copy)]
pub(crate) struct Error {
    context: &'static str,
    cause: Option<Cause>,
}

#[derive(Debug, Clone, Copy)]
enum Cause {
    Native(i32),
    Music(radio_core::music::Error),
    Transport(radio_webrtc::Error),
}
pub(crate) type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub(crate) fn new(context: &'static str) -> Self {
        Self {
            context,
            cause: None,
        }
    }
    pub(crate) fn native(context: &'static str, code: i32) -> Self {
        Self {
            context,
            cause: Some(Cause::Native(code)),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.context)?;
        match self.cause {
            Some(Cause::Native(code)) => write!(f, " (code {code})")?,
            Some(Cause::Music(error)) => write!(f, ": {error}")?,
            Some(Cause::Transport(error)) => write!(f, ": {error}")?,
            None => {}
        }
        Ok(())
    }
}
impl std::error::Error for Error {}
impl From<&'static str> for Error {
    fn from(value: &'static str) -> Self {
        Self::new(value)
    }
}
impl From<radio_core::music::Error> for Error {
    fn from(value: radio_core::music::Error) -> Self {
        Self {
            context: "music unavailable",
            cause: Some(Cause::Music(value)),
        }
    }
}
impl From<radio_webrtc::Error> for Error {
    fn from(value: radio_webrtc::Error) -> Self {
        Self {
            context: "WebRTC transport",
            cause: Some(Cause::Transport(value)),
        }
    }
}
pub(crate) fn check(code: i32, context: &'static str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(Error::native(context, code))
    }
}
