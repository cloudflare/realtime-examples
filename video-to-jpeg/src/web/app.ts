/**
 * Frontend for the WebRTC Video → JPEG demo.
 *
 * Publisher flow:
 *  - Capture camera via getUserMedia
 *  - Create WebRTC offer and send to /<session>/video/connect
 *  - When connected, call /<session>/video/start-forwarding
 *  - Also open JPEG viewer WebSocket
 *
 * Viewer flow:
 *  - Only open JPEG viewer WebSocket
 */

const url = new URL(window.location.href);
const parts = url.pathname.split('/').filter(Boolean);
const sessionId = parts[0] ?? 'default';
const role: 'publisher' | 'viewer' = parts[1] === 'publisher' ? 'publisher' : 'viewer';

// DOM elements
const btnConnect = document.querySelector<HTMLButtonElement>('#btnConnectCamera');
const btnStart = document.querySelector<HTMLButtonElement>('#btnStartStream');
const btnStop = document.querySelector<HTMLButtonElement>('#btnStopStream');
const btnReset = document.querySelector<HTMLButtonElement>('#btnResetSession');
const videoContainer = document.querySelector<HTMLDivElement>('#videoContainer');
const jpegContainer = document.querySelector<HTMLDivElement>('#jpegContainer');
const statusEl = document.querySelector<HTMLParagraphElement>('#statusText');

let pc: RTCPeerConnection | null = null;
let viewerSocket: WebSocket | null = null;
let latestObjectUrl: string | null = null;

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
}

function cleanupViewerSocket() {
  if (viewerSocket) {
    try {
      viewerSocket.close();
    } catch {
      // ignore
    }
    viewerSocket = null;
  }
  if (latestObjectUrl) {
    URL.revokeObjectURL(latestObjectUrl);
    latestObjectUrl = null;
  }
}

async function resetSession() {
  setStatus('Resetting session...');

  try {
    const res = await fetch(`/${sessionId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Reset failed: ${res.status} ${text}`);
    }

    cleanupViewerSocket();
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      pc = null;
    }

    setStatus('Session reset. You can reconnect the camera and start streaming again.');
  } catch (err: any) {
    console.error(err);
    setStatus(`Error resetting session: ${err?.message ?? err}`);
  }
}

function ensureViewerSocket() {
  if (viewerSocket) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/${sessionId}/video/viewer`;

  viewerSocket = new WebSocket(wsUrl);
  viewerSocket.binaryType = 'blob';

  viewerSocket.onopen = () => {
    setStatus(`Viewer WebSocket connected (${role}).`);
  };

  viewerSocket.onclose = () => {
    setStatus('Viewer WebSocket closed.');
  };

  viewerSocket.onerror = () => {
    setStatus('Viewer WebSocket error.');
  };

  viewerSocket.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (!(data instanceof Blob)) {
      return;
    }
    if (!jpegContainer) return;

    // Revoke previous object URL to avoid leaks
    if (latestObjectUrl) {
      URL.revokeObjectURL(latestObjectUrl);
      latestObjectUrl = null;
    }

    latestObjectUrl = URL.createObjectURL(data);

    let img = jpegContainer.querySelector<HTMLImageElement>('img');
    if (!img) {
      jpegContainer.innerHTML = '';
      img = document.createElement('img');
      jpegContainer.appendChild(img);
    }
    img.src = latestObjectUrl;
  };
}

async function connectCameraAndPublish() {
  if (!btnConnect || !btnStart || !videoContainer) return;

  btnConnect.disabled = true;
  setStatus('Requesting camera access...');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;
    videoContainer.innerHTML = '';
    videoContainer.appendChild(videoEl);

    if (pc) {
      pc.close();
      pc = null;
    }

    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    });

    stream.getTracks().forEach((track) => {
      pc!.addTrack(track, stream);
    });

    pc.oniceconnectionstatechange = () => {
      const state = pc?.iceConnectionState;
      setStatus(`ICE state: ${state}`);
    };

    setStatus('Creating offer...');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const connectRes = await fetch(`/${sessionId}/video/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDescription: offer }),
    });

    if (!connectRes.ok) {
      const text = await connectRes.text();
      throw new Error(`Connect failed: ${connectRes.status} ${text}`);
    }

    const connectJson = await connectRes.json();
    const answer = connectJson.sessionDescription as RTCSessionDescriptionInit;
    await pc.setRemoteDescription(answer);

    setStatus('WebRTC connected. You can now start JPEG streaming.');
    btnStart.disabled = false;
  } catch (err: any) {
    console.error(err);
    setStatus(`Error connecting camera: ${err?.message ?? err}`);
    btnConnect.disabled = false;
  }
}

async function startForwarding() {
  if (!btnStart || !btnStop) return;

  btnStart.disabled = true;
  setStatus('Starting JPEG forwarding via adapter...');

  try {
    const res = await fetch(`/${sessionId}/video/start-forwarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Start-forwarding failed: ${res.status} ${text}`);
    }

    setStatus('JPEG forwarding active. Opening viewer WebSocket...');
    ensureViewerSocket();
    btnStop.disabled = false;
  } catch (err: any) {
    console.error(err);
    setStatus(`Error starting forwarding: ${err?.message ?? err}`);
    btnStart.disabled = false;
  }
}

async function stopForwarding() {
  if (!btnStart || !btnStop) return;

  btnStop.disabled = true;
  setStatus('Stopping JPEG forwarding...');

  try {
    const res = await fetch(`/${sessionId}/video/stop-forwarding`, {
      method: 'POST',
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stop-forwarding failed: ${res.status} ${text}`);
    }

    setStatus('Forwarding stopped.');
  } catch (err: any) {
    console.error(err);
    setStatus(`Error stopping forwarding: ${err?.message ?? err}`);
  } finally {
    btnStart.disabled = false;
  }
}

function init() {
  if (role === 'publisher') {
    if (btnConnect) btnConnect.disabled = false;
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    if (btnReset) btnReset.disabled = false;

    setStatus(`Role: publisher (session: ${sessionId})`);

    btnConnect?.addEventListener('click', () => {
      void connectCameraAndPublish();
    });

    btnStart?.addEventListener('click', () => {
      void startForwarding();
    });

    btnStop?.addEventListener('click', () => {
      void stopForwarding();
    });

    btnReset?.addEventListener('click', () => {
      void resetSession();
    });
  } else {
    // Viewer-only: just open JPEG stream
    if (btnConnect) btnConnect.disabled = true;
    if (btnStart) btnStart.disabled = true;
    if (btnStop) btnStop.disabled = true;
    setStatus(`Role: viewer (session: ${sessionId})`);
    ensureViewerSocket();
  }
}

window.addEventListener('load', init);

window.addEventListener('beforeunload', () => {
  cleanupViewerSocket();
  if (pc) {
    try {
      pc.close();
    } catch {
      // ignore
    }
    pc = null;
  }
});
