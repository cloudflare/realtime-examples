/**
 * SFU (Realtime SFU) helper utilities for the video-to-jpeg demo.
 */

import { Packet } from "../packet";

/**
 * Compute the SFU API base URL from environment variables.
 */
export function getSfuApiBase(env: Env): string {
  return `${env.SFU_API_BASE}/apps/${env.REALTIME_SFU_APP_ID}`;
}

/**
 * Simple SFU API client used by the VideoAdapter Durable Object.
 */
export class SfuClient {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private get base(): string {
    return getSfuApiBase(this.env);
  }

  private get headers(): Record<string, string> {
    return getSfuAuthHeaders(this.env);
  }

  // --- Sessions & Tracks ---

  async createSession(): Promise<{ sessionId: string }> {
    const res = await fetch(`${this.base}/sessions/new`, {
      method: "POST",
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`SFU createSession failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const sessionId = json?.sessionId;
    if (!sessionId) throw new Error("SFU createSession: sessionId missing in response");
    return { sessionId };
  }

  /**
   * Adds tracks to an existing session using autoDiscover from the provided SDP offer.
   * Returns the full JSON response and the first video trackName (if present).
   */
  async addTracksAutoDiscoverForVideo(
    sessionId: string,
    sessionDescription: any
  ): Promise<{ json: any; videoTrackName?: string }> {
    const body = { autoDiscover: true, sessionDescription };
    const res = await fetch(`${this.base}/sessions/${sessionId}/tracks/new`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`SFU addTracksAutoDiscover failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const tracks = json?.tracks ?? [];
    const video = tracks.find((t: any) => t.kind === "video");
    const videoTrackName = video?.trackName || tracks[0]?.trackName;
    return { json, videoTrackName };
  }

  /**
   * Configure a WebSocket adapter in remote (stream) mode.
   * Used to stream a remote video track as JPEG frames to a WebSocket endpoint.
   */
  async pullTrackToWebSocket(
    sessionId: string,
    trackName: string,
    endpoint: string,
    opts?: { outputCodec?: "pcm" | "jpeg" }
  ): Promise<{ adapterId?: string; json: any }> {
    const body = {
      tracks: [
        {
          location: "remote",
          sessionId,
          trackName,
          endpoint,
          outputCodec: opts?.outputCodec ?? "jpeg",
        },
      ],
    };
    const res = await fetch(`${this.base}/adapters/websocket/new`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SFU pullTrackToWebSocket failed: ${res.status} ${text}`);
    }
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {}
    const adapterId = json?.tracks?.[0]?.adapterId as string | undefined;
    return { adapterId, json };
  }

  /**
   * Idempotent close for WebSocket adapters.
   * If SFU returns 503 adapter_not_found, treat as already-closed success.
   */
  async closeWebSocketAdapter(
    adapterId: string
  ): Promise<{ ok: boolean; alreadyClosed: boolean; status: number; text: string }> {
    const body = { tracks: [{ adapterId }] };
    const res = await fetch(`${this.base}/adapters/websocket/close`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return { ok: true, alreadyClosed: false, status: res.status, text };
    let alreadyClosed = false;
    if (res.status === 503) {
      try {
        const j = JSON.parse(text);
        if (j?.tracks?.[0]?.errorCode === "adapter_not_found") alreadyClosed = true;
      } catch {}
    }
    return { ok: alreadyClosed, alreadyClosed, status: res.status, text };
  }
}

/**
 * Standard SFU authorization headers.
 */
export function getSfuAuthHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.REALTIME_SFU_BEARER_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Builds a WebSocket callback URL from an HTTP request and path.
 */
export function buildWsCallbackUrl(request: Request, path: string): string {
  const url = new URL(request.url);
  url.pathname = path;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Extract JPEG payload from an SFU Packet.
 * Returns a copy of the payload bytes or null if missing.
 */
export function extractJpegFromSfuPacket(packetData: ArrayBuffer): Uint8Array | null {
  try {
    const packet = Packet.fromBinary(new Uint8Array(packetData));
    if (!packet.payload || packet.payload.length === 0) {
      return null;
    }
    // Return a safe copy of the payload bytes
    return new Uint8Array(packet.payload);
  } catch (error) {
    console.error("Error decoding SFU Packet for video:", error);
    return null;
  }
}
