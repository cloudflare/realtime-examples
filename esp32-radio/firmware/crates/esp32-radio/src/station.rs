//! Coalesced metadata between the radio owner and blocking HTTP signaling task.
use crate::error::{Error, Result};
use radio_core::now_playing::NowPlaying;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(crate) struct Station(Arc<Mutex<Option<Arc<NowPlaying>>>>);

impl Station {
    pub(crate) fn publish(&self, value: &NowPlaying) -> Result<()> {
        let snapshot = Arc::new(value.clone());
        *self
            .0
            .lock()
            .map_err(|_| Error::new("station metadata unavailable"))? = Some(snapshot);
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Result<Option<Arc<NowPlaying>>> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Error::new("station metadata unavailable"))?
            .clone())
    }
}
