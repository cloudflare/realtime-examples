//! Autonomous SFU session orchestration through the authenticated Worker API.
use crate::{
    error::{Error, Result},
    platform::{self, Http},
    radio::{Event, Request},
};
use radio_core::signaling::{self, Channels, Started};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    ffi::CStr,
    sync::mpsc::{Receiver, SyncSender, sync_channel},
    thread,
    time::Duration,
};

#[derive(Clone, Copy)]
enum Endpoint {
    Start,
    Channels,
    Ready,
    Heartbeat,
}
impl Endpoint {
    fn path(self) -> &'static CStr {
        match self {
            Self::Start => c"start",
            Self::Channels => c"channels",
            Self::Ready => c"ready",
            Self::Heartbeat => c"heartbeat",
        }
    }
}

struct Client {
    http: Http,
}
impl Client {
    fn new() -> Result<Self> {
        Ok(Self {
            http: Http::open()?,
        })
    }
    fn post(&mut self, endpoint: Endpoint, body: &[u8]) -> Result<(i32, &[u8])> {
        let (status, response) = self.http.post(endpoint.path(), body)?;
        platform::log(&format!(
            "HTTPS {}: status={status}",
            endpoint.path().to_str().expect("constant ASCII path")
        ));
        Ok((status, response))
    }
    fn retry<T: DeserializeOwned>(
        &mut self,
        endpoint: Endpoint,
        body: &impl Serialize,
    ) -> Result<T> {
        // Reuse the request body across retries, including the initial bootId and offer.
        let body =
            serde_json::to_vec(body).map_err(|_| Error::new("request serialization failed"))?;
        for attempt in 0..3 {
            let (status, response) = self.post(endpoint, &body)?;
            if (200..300).contains(&status) {
                return serde_json::from_slice(response)
                    .map_err(|_| Error::new("invalid Worker response"));
            }
            if !signaling::retryable(status) {
                return Err(Error::native("Worker rejected setup", status));
            }
            if attempt < 2 {
                thread::sleep(Duration::from_secs(1 << attempt));
            }
        }
        Err(Error::new("Worker unavailable after setup retries"))
    }
}

pub(crate) fn run(
    requests: SyncSender<Request>,
    events: Receiver<Event>,
    station: crate::station::Station,
) -> Result<()> {
    let mut client = Client::new()?;
    let (offer, now_playing) = match events.recv_timeout(Duration::from_secs(20)) {
        Ok(Event::Offer { sdp, now_playing }) => (sdp, now_playing),
        _ => return Err(Error::new("local offer unavailable")),
    };
    let boot_id = format!(
        "{:08x}{:08x}{:08x}{:08x}",
        platform::random(),
        platform::random(),
        platform::random(),
        platform::random()
    );
    let started: Started = client.retry(
        Endpoint::Start,
        &serde_json::json!({
            "bootId": boot_id, "sessionDescription": {"type": "offer", "sdp": offer},
            "track": now_playing.track, "nowPlaying": now_playing
        }),
    )?;
    let (identity, answer) = started.validate()?;
    let (reply, received) = sync_channel(1);
    requests
        .try_send(Request::Answer(answer, reply))
        .map_err(|_| Error::new("radio task unavailable"))?;
    received
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| Error::new("answer application timed out"))??;
    match events.recv_timeout(Duration::from_secs(30)) {
        Ok(Event::Connected) => {}
        _ => return Err(Error::new("WebRTC connection timed out")),
    }
    let channels: Channels = client.retry(Endpoint::Channels, &identity)?;
    let ids = channels.validate()?;
    let (reply, received) = sync_channel(1);
    requests
        .try_send(Request::Start(ids, reply))
        .map_err(|_| Error::new("radio task unavailable"))?;
    received
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| Error::new("playback start timed out"))??;
    let _: serde_json::Map<String, serde_json::Value> = client.retry(Endpoint::Ready, &identity)?;
    platform::recovery_attempt(true);
    platform::log(
        "ON AIR: autonomous Wi-Fi signaling, audio and data; firmware=rust; USB is optional",
    );
    let mut last_success = platform::now_us();
    let mut next_heartbeat = last_success;
    let mut next_change_post = last_success;
    let mut published_revision = None;
    loop {
        if events.try_iter().any(|event| matches!(event, Event::Lost)) {
            return Err(Error::new("WebRTC transport lost"));
        }
        thread::sleep(Duration::from_millis(100));
        let now = platform::now_us();
        let Some(snapshot) = station.snapshot()? else {
            continue;
        };
        let changed = published_revision != Some(snapshot.revision);
        if now < next_heartbeat && (!changed || now < next_change_post) {
            continue;
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Heartbeat<'a> {
            #[serde(flatten)]
            identity: &'a signaling::Identity,
            now_playing: &'a radio_core::now_playing::NowPlaying,
        }
        let body = serde_json::to_vec(&Heartbeat {
            identity: &identity,
            now_playing: &snapshot,
        })
        .map_err(|_| Error::new("heartbeat serialization failed"))?;
        let (status, response) = client.post(Endpoint::Heartbeat, &body)?;
        let valid = (200..300).contains(&status)
            && serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(response)
                .is_ok();
        next_heartbeat = platform::now_us() + 5_000_000;
        next_change_post = platform::now_us() + if valid { 250_000 } else { 1_000_000 };
        if valid {
            last_success = platform::now_us();
            published_revision = Some(snapshot.revision);
        } else if signaling::needs_recovery(status, platform::now_us().saturating_sub(last_success))
        {
            return Err(Error::native("signaling session needs recovery", status));
        }
    }
}
