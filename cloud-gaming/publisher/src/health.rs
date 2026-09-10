use std::time::Duration;

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};

pub const PORT: u16 = 8080;

pub async fn serve() -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .await
        .context("bind publisher health port")?;
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .context("accept publisher health request")?;
        respond(&mut stream).await?;
    }
}

async fn respond(stream: &mut TcpStream) -> Result<()> {
    let mut request = [0_u8; 1024];
    let length = timeout(Duration::from_secs(2), stream.read(&mut request))
        .await
        .context("publisher health request timed out")?
        .context("read publisher health request")?;
    let healthy = request[..length].starts_with(b"GET /health ");
    let response = if healthy {
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
    } else {
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found"
    };
    stream
        .write_all(response.as_bytes())
        .await
        .context("write publisher health response")
}
