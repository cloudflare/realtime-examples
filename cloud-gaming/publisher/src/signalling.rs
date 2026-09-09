use std::{collections::BTreeSet, time::Duration};

use anyhow::{Context, Result, bail};
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

pub const SIGNALLING_ORIGIN: &str = "http://realtime.internal";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const SAFE_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(100), Duration::from_millis(250)];
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_SDP_BYTES: usize = 1_048_576;
const MAX_RESPONSE_BYTES: u64 = 2_097_152;

#[derive(Clone)]
pub struct SignallingClient {
    client: Client,
    origin: Url,
    run_id: String,
    run_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Viewport {
    pub width: u16,
    pub height: u16,
    pub fps: u8,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct RegisteredSession {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionDescriptionType {
    Offer,
    Answer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionDescription {
    pub sdp: String,
    #[serde(rename = "type")]
    pub kind: SessionDescriptionType,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PublishResponse {
    #[serde(rename = "sessionDescription")]
    pub session_description: SessionDescription,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct DataChannelEstablishResponse {
    #[serde(rename = "sessionDescription")]
    pub session_description: SessionDescription,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ControllerPoll {
    pub generation: u64,
    pub controller: Option<Controller>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Controller {
    pub id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InputKind {
    Keyboard,
    Pointer,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PublisherInputs {
    #[serde(rename = "dataChannels")]
    pub data_channels: Vec<PublisherInputChannel>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PublisherInputChannel {
    #[serde(rename = "dataChannelName")]
    pub data_channel_name: String,
    pub id: u16,
    pub kind: InputKind,
}

impl RegisteredSession {
    fn validate(&self) -> Result<()> {
        validate_text("sessionId", &self.session_id, MAX_IDENTIFIER_BYTES)
    }
}

impl SessionDescription {
    fn validate_answer(&self, operation: &str) -> Result<()> {
        validate_text("sessionDescription.sdp", &self.sdp, MAX_SDP_BYTES)?;
        if self.kind != SessionDescriptionType::Answer {
            bail!("publisher signaling {operation} returned a non-answer SDP");
        }
        Ok(())
    }

    fn validate_offer(&self, operation: &str) -> Result<()> {
        validate_text("sessionDescription.sdp", &self.sdp, MAX_SDP_BYTES)?;
        if self.kind != SessionDescriptionType::Offer {
            bail!("publisher signaling {operation} returned a non-offer SDP");
        }
        Ok(())
    }
}

impl Controller {
    fn validate(&self) -> Result<()> {
        validate_text("controller.id", &self.id, MAX_IDENTIFIER_BYTES)
    }
}

impl ControllerPoll {
    fn validate(&self) -> Result<()> {
        if let Some(controller) = &self.controller {
            controller.validate()?;
            if controller.generation != self.generation {
                bail!("controller generation does not match the poll generation");
            }
        }
        Ok(())
    }
}

impl PublisherInputs {
    fn validate(&self) -> Result<()> {
        if self.data_channels.len() != 2 {
            bail!("publisher inputs must contain exactly two DataChannels");
        }

        let mut kinds = BTreeSet::new();
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for channel in &self.data_channels {
            validate_text(
                "dataChannelName",
                &channel.data_channel_name,
                MAX_IDENTIFIER_BYTES,
            )?;
            if !kinds.insert(match channel.kind {
                InputKind::Keyboard => 0,
                InputKind::Pointer => 1,
            }) {
                bail!("publisher inputs contain a duplicate reliability lane");
            }
            if !ids.insert(channel.id) {
                bail!("publisher inputs contain a duplicate DataChannel id");
            }
            if !names.insert(channel.data_channel_name.as_str()) {
                bail!("publisher inputs contain a duplicate DataChannel name");
            }
        }
        if kinds.len() != 2 {
            bail!("publisher inputs require one keyboard and one pointer DataChannel");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
struct RegisterRequest<'a> {
    viewport: &'a Viewport,
}

#[derive(Debug, Serialize)]
struct PublishRequest<'a> {
    #[serde(rename = "sessionDescription")]
    session_description: SessionDescriptionRequest<'a>,
    video: LocalTrackRequest<'a>,
    audio: LocalTrackRequest<'a>,
}

#[derive(Debug, Serialize)]
struct SessionDescriptionRequest<'a> {
    sdp: &'a str,
    #[serde(rename = "type")]
    kind: SessionDescriptionType,
}

#[derive(Debug, Serialize)]
struct LocalTrackRequest<'a> {
    mid: &'a str,
    #[serde(rename = "trackName")]
    track_name: &'a str,
}

#[derive(Debug, Serialize)]
struct CompleteDataChannelRequest<'a> {
    #[serde(rename = "sessionDescription")]
    session_description: SessionDescriptionRequest<'a>,
}

#[derive(Debug, Deserialize)]
struct AckResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    error: String,
}

#[derive(Debug, Clone, Copy)]
enum RetryPolicy {
    Never,
    Safe,
}

impl SignallingClient {
    pub fn new(run_id: String, run_generation: u64) -> Result<Self> {
        Self::with_origin(SIGNALLING_ORIGIN, run_id, run_generation)
    }

    fn with_origin(origin: &str, run_id: String, run_generation: u64) -> Result<Self> {
        let origin = Url::parse(origin).context("parse publisher signaling origin")?;
        if origin.cannot_be_a_base()
            || !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            bail!("publisher signaling origin must be an HTTP base URL");
        }
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::none())
            .build()
            .context("build publisher signaling client")?;
        Ok(Self {
            client,
            origin,
            run_id,
            run_generation,
        })
    }

    pub async fn register_session(&self, viewport: &Viewport) -> Result<RegisteredSession> {
        let registered: RegisteredSession = self
            .post(
                "register",
                &RegisterRequest { viewport },
                RetryPolicy::Never,
            )
            .await?;
        registered.validate()?;
        Ok(registered)
    }

    pub async fn publish(
        &self,
        offer_sdp: &str,
        video_mid: &str,
        video_track_name: &str,
        audio_mid: &str,
        audio_track_name: &str,
    ) -> Result<PublishResponse> {
        let response: PublishResponse = self
            .post(
                "publish",
                &PublishRequest {
                    session_description: SessionDescriptionRequest {
                        sdp: offer_sdp,
                        kind: SessionDescriptionType::Offer,
                    },
                    video: LocalTrackRequest {
                        mid: video_mid,
                        track_name: video_track_name,
                    },
                    audio: LocalTrackRequest {
                        mid: audio_mid,
                        track_name: audio_track_name,
                    },
                },
                RetryPolicy::Never,
            )
            .await?;
        response.session_description.validate_answer("publish")?;
        Ok(response)
    }

    pub async fn heartbeat(&self) -> Result<()> {
        let response: AckResponse = self
            .post("heartbeat", &serde_json::json!({}), RetryPolicy::Safe)
            .await?;
        require_ack(response, "heartbeat")
    }

    pub async fn establish_data_channels(&self) -> Result<DataChannelEstablishResponse> {
        let response: DataChannelEstablishResponse = self
            .post(
                "datachannels/establish",
                &serde_json::json!({}),
                RetryPolicy::Never,
            )
            .await?;
        response
            .session_description
            .validate_offer("datachannels/establish")?;
        Ok(response)
    }

    pub async fn poll_controller(&self) -> Result<ControllerPoll> {
        let poll: ControllerPoll = self
            .post("controller/poll", &serde_json::json!({}), RetryPolicy::Safe)
            .await?;
        poll.validate()?;
        Ok(poll)
    }

    pub async fn complete_data_channels(&self, answer_sdp: &str) -> Result<PublisherInputs> {
        let inputs: PublisherInputs = self
            .post(
                "datachannels/complete",
                &CompleteDataChannelRequest {
                    session_description: SessionDescriptionRequest {
                        sdp: answer_sdp,
                        kind: SessionDescriptionType::Answer,
                    },
                },
                RetryPolicy::Never,
            )
            .await?;
        inputs.validate()?;
        Ok(inputs)
    }

    pub async fn stop(&self) -> Result<()> {
        let response: AckResponse = self
            .post("stop", &serde_json::json!({}), RetryPolicy::Safe)
            .await?;
        require_ack(response, "stop")
    }

    fn endpoint(&self, operation: &str) -> Result<Url> {
        let path = format!(
            "/v1/game-runs/{}/generations/{}/publisher/{operation}",
            self.run_id, self.run_generation
        );
        self.origin
            .join(&path)
            .context("build publisher signaling URL")
    }

    async fn post<T, B>(&self, operation: &str, body: &B, retry: RetryPolicy) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize + ?Sized,
    {
        let url = self.endpoint(operation)?;
        let attempts = match retry {
            RetryPolicy::Never => 1,
            RetryPolicy::Safe => SAFE_RETRY_DELAYS.len() + 1,
        };

        for attempt in 0..attempts {
            let response = match self.client.post(url.clone()).json(body).send().await {
                Ok(response) => response,
                Err(error)
                    if matches!(retry, RetryPolicy::Safe)
                        && attempt + 1 < attempts
                        && (error.is_connect() || error.is_timeout()) =>
                {
                    sleep(SAFE_RETRY_DELAYS[attempt]).await;
                    continue;
                }
                Err(error) => {
                    return Err(error).context("send publisher signaling request");
                }
            };

            let status = response.status();
            if matches!(retry, RetryPolicy::Safe)
                && attempt + 1 < attempts
                && retryable_status(status)
            {
                let _ = response.bytes().await;
                sleep(SAFE_RETRY_DELAYS[attempt]).await;
                continue;
            }

            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES)
            {
                bail!("publisher signaling response exceeded the size limit");
            }
            let response_body = response
                .bytes()
                .await
                .context("read publisher signaling response")?;
            if response_body.len() as u64 > MAX_RESPONSE_BYTES {
                bail!("publisher signaling response exceeded the size limit");
            }
            if !status.is_success() {
                let message = serde_json::from_slice::<ApiError>(&response_body)
                    .ok()
                    .map(|value| value.error)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| format!("publisher signaling returned {status}"));
                bail!("{message}");
            }
            return serde_json::from_slice(&response_body)
                .context("decode publisher signaling response");
        }

        unreachable!("publisher signaling retry loop always returns")
    }
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn require_ack(response: AckResponse, operation: &str) -> Result<()> {
    if !response.ok {
        bail!("publisher signaling {operation} was not acknowledged");
    }
    Ok(())
}

fn validate_text(field: &str, value: &str, max_bytes: usize) -> Result<()> {
    if value.is_empty() || value.len() > max_bytes {
        bail!("{field} must contain between 1 and {max_bytes} bytes");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc,
        thread,
    };

    use serde_json::{Value, json};

    use super::{
        Controller, ControllerPoll, InputKind, PublisherInputChannel, PublisherInputs,
        SessionDescription, SessionDescriptionType, SignallingClient, Viewport,
    };

    #[derive(Debug)]
    struct CapturedRequest {
        path: String,
        headers: BTreeMap<String, String>,
        body: Value,
    }

    #[tokio::test]
    async fn uses_the_path_bound_contract_without_credentials() {
        let responses = vec![
            (201, json!({"sessionId": "calls-session"})),
            (
                200,
                json!({"sessionDescription": {"sdp": "media-answer", "type": "answer"}}),
            ),
            (200, json!({"ok": true})),
            (
                200,
                json!({"sessionDescription": {"sdp": "data-offer", "type": "offer"}}),
            ),
            (
                200,
                json!({
                    "dataChannels": [
                        {"dataChannelName": "keyboard-1", "id": 4, "kind": "keyboard"},
                        {"dataChannelName": "pointer-1", "id": 6, "kind": "pointer"}
                    ]
                }),
            ),
            (
                200,
                json!({
                    "generation": 11,
                    "controller": {"id": "viewer-1", "generation": 11}
                }),
            ),
            (200, json!({"ok": true})),
        ];
        let (origin, requests, server) = test_server(responses);
        let client =
            SignallingClient::with_origin(&origin, "run-123".to_owned(), 7).expect("build client");
        let viewport = Viewport {
            width: 800,
            height: 600,
            fps: 30,
        };

        let registered = client
            .register_session(&viewport)
            .await
            .expect("register publisher");
        assert_eq!(registered.session_id, "calls-session");
        let published = client
            .publish(
                "media-offer",
                "video-mid",
                "video-track",
                "audio-mid",
                "audio-track",
            )
            .await
            .expect("publish media");
        assert_eq!(
            published.session_description.kind,
            SessionDescriptionType::Answer
        );
        client.heartbeat().await.expect("heartbeat");
        let established = client
            .establish_data_channels()
            .await
            .expect("establish DataChannel transport");
        assert_eq!(established.session_description.sdp, "data-offer");
        let inputs = client
            .complete_data_channels("data-answer")
            .await
            .expect("complete publisher DataChannel transport");
        assert_eq!(inputs.data_channels[0].kind, InputKind::Keyboard);
        let poll = client.poll_controller().await.expect("poll controller");
        assert_eq!(poll.generation, 11);
        client.stop().await.expect("stop publisher");

        let requests: Vec<_> = (0..7)
            .map(|_| requests.recv().expect("capture request"))
            .collect();
        server.join().expect("join test server");
        let prefix = "/v1/game-runs/run-123/generations/7/publisher";
        assert_eq!(
            requests
                .iter()
                .map(|request| request.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                format!("{prefix}/register"),
                format!("{prefix}/publish"),
                format!("{prefix}/heartbeat"),
                format!("{prefix}/datachannels/establish"),
                format!("{prefix}/datachannels/complete"),
                format!("{prefix}/controller/poll"),
                format!("{prefix}/stop"),
            ]
        );
        assert_eq!(
            requests[0].body,
            json!({"viewport": {"width": 800, "height": 600, "fps": 30}})
        );
        assert_eq!(
            requests[1].body,
            json!({
                "sessionDescription": {"sdp": "media-offer", "type": "offer"},
                "video": {"mid": "video-mid", "trackName": "video-track"},
                "audio": {"mid": "audio-mid", "trackName": "audio-track"}
            })
        );
        assert_eq!(requests[3].body, json!({}));
        assert_eq!(
            requests[4].body,
            json!({
                "sessionDescription": {"sdp": "data-answer", "type": "answer"}
            })
        );
        for request in requests {
            assert!(!request.headers.contains_key("authorization"));
            assert!(!request.headers.contains_key("cookie"));
        }
    }

    #[tokio::test]
    async fn retries_only_a_safe_operation_and_stops_after_a_bound() {
        let responses = vec![
            (503, json!({"error": "temporary"})),
            (503, json!({"error": "temporary"})),
            (200, json!({"ok": true})),
        ];
        let (origin, requests, server) = test_server(responses);
        let client =
            SignallingClient::with_origin(&origin, "run-123".to_owned(), 7).expect("build client");

        client.heartbeat().await.expect("retry heartbeat");

        let captured: Vec<_> = (0..3)
            .map(|_| requests.recv().expect("capture retry"))
            .collect();
        server.join().expect("join retry server");
        assert!(
            captured
                .iter()
                .all(|request| request.path.ends_with("/heartbeat"))
        );
    }

    #[tokio::test]
    async fn does_not_retry_a_mutating_publish_request() {
        let (origin, requests, server) = test_server(vec![(503, json!({"error": "temporary"}))]);
        let client =
            SignallingClient::with_origin(&origin, "run-123".to_owned(), 7).expect("build client");

        let error = client
            .publish(
                "media-offer",
                "video-mid",
                "video-track",
                "audio-mid",
                "audio-track",
            )
            .await
            .expect_err("publish must not retry");

        assert_eq!(error.to_string(), "temporary");
        let request = requests.recv().expect("capture publish");
        assert!(request.path.ends_with("/publish"));
        server.join().expect("join publish server");
    }

    #[test]
    fn rejects_invalid_signaling_response_metadata() {
        assert!(
            SessionDescription {
                sdp: String::new(),
                kind: SessionDescriptionType::Answer,
            }
            .validate_answer("test")
            .is_err()
        );
        assert!(
            ControllerPoll {
                generation: 4,
                controller: Some(Controller {
                    id: "control-1".to_owned(),
                    generation: 5,
                }),
            }
            .validate()
            .is_err()
        );

        let duplicate_lanes = PublisherInputs {
            data_channels: vec![
                PublisherInputChannel {
                    data_channel_name: "keyboard-1".to_owned(),
                    id: 2,
                    kind: InputKind::Keyboard,
                },
                PublisherInputChannel {
                    data_channel_name: "keyboard-2".to_owned(),
                    id: 4,
                    kind: InputKind::Keyboard,
                },
            ],
        };
        assert!(duplicate_lanes.validate().is_err());
    }

    fn test_server(
        responses: Vec<(u16, Value)>,
    ) -> (
        String,
        mpsc::Receiver<CapturedRequest>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("read test server address");
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept request");
                let request = read_request(&mut stream);
                request_tx.send(request).expect("record request");
                let body = serde_json::to_vec(&body).expect("encode response");
                let reason = match status {
                    200 => "OK",
                    201 => "Created",
                    503 => "Service Unavailable",
                    _ => "Test",
                };
                write!(
                    stream,
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .expect("write response headers");
                stream.write_all(&body).expect("write response body");
            }
        });
        (format!("http://{address}"), request_rx, server)
    }

    fn read_request(stream: &mut TcpStream) -> CapturedRequest {
        let mut received = Vec::new();
        let mut buffer = [0_u8; 2048];
        let header_end = loop {
            let length = stream.read(&mut buffer).expect("read request");
            assert!(length > 0, "request ended before headers");
            received.extend_from_slice(&buffer[..length]);
            if let Some(index) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers_text =
            std::str::from_utf8(&received[..header_end]).expect("decode request headers");
        let mut lines = headers_text.split("\r\n");
        let path = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .expect("read request path")
            .to_owned();
        let mut headers = BTreeMap::new();
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':').expect("parse request header");
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
        let content_length = headers
            .get("content-length")
            .expect("read content length")
            .parse::<usize>()
            .expect("parse content length");
        while received.len() < header_end + content_length {
            let length = stream.read(&mut buffer).expect("read request body");
            assert!(length > 0, "request ended before body");
            received.extend_from_slice(&buffer[..length]);
        }
        let body = serde_json::from_slice(&received[header_end..header_end + content_length])
            .expect("decode request body");
        CapturedRequest {
            path,
            headers,
            body,
        }
    }
}
