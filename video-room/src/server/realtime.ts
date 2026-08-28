import type { SessionDescription } from "../shared/protocol";

export type RealtimeEnv = {
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_BEARER_TOKEN?: string;
};

export type SfuTrack = {
  errorCode?: string;
  errorDescription?: string;
  mid: string;
  sessionId?: string;
  trackName?: string;
};

export type SfuTracksResponse = {
  errorCode?: string;
  errorDescription?: string;
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
  tracks?: SfuTrack[];
};

export interface SfuClient {
  addTracks(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuTracksResponse>;
  closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<SfuTracksResponse>;
  createSession(): Promise<string>;
  renegotiate(
    sessionId: string,
    answer: SessionDescription,
  ): Promise<void>;
}

export class SfuRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly track?: {
    mid?: string;
    trackName?: string;
  };

  constructor(
    code: string,
    message: string,
    status = 502,
    retryable?: boolean,
    track?: {
      mid?: string;
      trackName?: string;
    },
  ) {
    super(message);
    this.name = "SfuRequestError";
    this.code = sanitizeErrorIdentifier(code) ?? "sfu_error";
    this.status = normalizeStatus(status, 502);
    this.retryable = retryable ?? isRetryableSfuStatus(this.status);
    this.track = track;
  }
}

const ERROR_IDENTIFIER = /^[a-z0-9][a-z0-9_]{0,79}$/;

export function isRetryableSfuStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function hasSfuError(value: {
  errorCode?: unknown;
  errorDescription?: unknown;
}): boolean {
  return (
    typeof value.errorCode === "string" ||
    typeof value.errorDescription === "string"
  );
}

export function sfuResponseError(
  value: {
    errorCode?: unknown;
    errorDescription?: unknown;
    mid?: unknown;
    trackName?: unknown;
  },
  message: string,
  status = 502,
): SfuRequestError {
  return new SfuRequestError(
    sanitizeErrorIdentifier(value.errorCode) ?? "sfu_upstream_error",
    message,
    status,
    undefined,
    trackLocator(value),
  );
}

export function sanitizeErrorIdentifier(
  value: unknown,
): string | undefined {
  return typeof value === "string" && ERROR_IDENTIFIER.test(value)
    ? value
    : undefined;
}

type Fetch = typeof fetch;

export class RealtimeSfuClient implements SfuClient {
  private readonly appId: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly token: string;

  constructor(
    env: RealtimeEnv,
    private readonly fetcher: Fetch = (input, init) =>
      globalThis.fetch(input, init),
    requestTimeoutMs = 10_000,
  ) {
    this.appId = requireBinding(env.REALTIME_SFU_APP_ID, "REALTIME_SFU_APP_ID");
    this.token = requireBinding(
      env.REALTIME_SFU_BEARER_TOKEN,
      "REALTIME_SFU_BEARER_TOKEN",
    );
    this.baseUrl = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(this.appId)}`;
    this.requestTimeoutMs = Math.min(
      Math.max(Math.trunc(requestTimeoutMs), 1),
      30_000,
    );
  }

  async createSession(): Promise<string> {
    const response = await this.request<{ sessionId?: string }>(
      "/sessions/new",
      "POST",
    );
    if (!response.sessionId) {
      throw new SfuRequestError(
        "sfu_session_invalid",
        "Realtime SFU did not return a session identifier.",
        502,
      );
    }
    return response.sessionId;
  }

  addTracks(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuTracksResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      "POST",
      body,
    );
  }

  closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<SfuTracksResponse> {
    if (mids.length === 0) {
      return Promise.resolve({ tracks: [] });
    }
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      "PUT",
      {
        force: true,
        tracks: mids.map((mid) => ({ mid })),
      },
    );
  }

  async renegotiate(
    sessionId: string,
    answer: SessionDescription,
  ): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      "PUT",
      { sessionDescription: answer },
    );
  }

  private async request<Payload>(
    path: string,
    method: "POST" | "PUT",
    body?: Record<string, unknown>,
  ): Promise<Payload> {
    let response: globalThis.Response;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        method,
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new SfuRequestError(
          "sfu_request_timed_out",
          "Realtime SFU did not respond before the request timeout.",
          504,
        );
      }
      throw new SfuRequestError(
        "sfu_unreachable",
        "Realtime SFU could not be reached. Retry the operation.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = await responseObject(response);
    const responseStatus = normalizeStatus(response.status, 502);
    if (!response.ok) {
      throw sfuResponseError(
        payload ?? {},
        isRetryableSfuStatus(responseStatus)
          ? "Realtime SFU could not complete the operation."
          : "Realtime SFU rejected the operation.",
        responseStatus,
      );
    }
    if (!payload) {
      throw new SfuRequestError(
        "sfu_response_invalid",
        "Realtime SFU returned an unreadable response.",
      );
    }

    if (hasSfuError(payload)) {
      throw sfuResponseError(
        payload,
        "Realtime SFU could not complete the operation.",
      );
    }
    return payload as Payload;
  }
}

function requireBinding(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new SfuRequestError(
      "sfu_not_configured",
      `${name} is not configured on the Worker.`,
      503,
      false,
    );
  }
  return normalized;
}

function normalizeStatus(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isInteger(value) && value! >= 400 && value! <= 599
    ? value!
    : fallback;
}

function trackLocator(value: {
  mid?: unknown;
  trackName?: unknown;
}): SfuRequestError["track"] {
  const mid = sanitizeTrackLocator(value.mid);
  const trackName = sanitizeTrackLocator(value.trackName);
  return mid || trackName ? { mid, trackName } : undefined;
}

function sanitizeTrackLocator(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

async function responseObject(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
