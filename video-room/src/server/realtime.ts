import { z } from "zod";
import {
  sessionDescriptionSchema,
  type SessionDescription,
} from "../shared/protocol";

export type RealtimeEnv = {
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_BEARER_TOKEN?: string;
};

const responseObjectSchema = z.looseObject({});
const sessionResponseSchema = z.looseObject({ sessionId: z.string().min(1) });
const trackMidSchema = z.object({ mid: z.string().min(1) });
const trackSchema = z.looseObject({
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
  mid: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  trackName: z.string().optional(),
});
const tracksResponseSchema = z.looseObject({
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
  requiresImmediateRenegotiation: z.boolean().optional(),
  sessionDescription: sessionDescriptionSchema.optional(),
  tracks: z.array(trackSchema).optional(),
});
const closeResponseSchema = z.looseObject({
  requiresImmediateRenegotiation: z.boolean().optional(),
  tracks: z.array(responseObjectSchema).optional(),
});

// Track operations return the raw object so allocated mids can be retained
// before malformed or failed items are rejected by parseSfuTracksResponse.
export type SfuResponse = z.infer<typeof responseObjectSchema>;
export type SfuTrack = z.infer<typeof trackSchema>;
export type SfuTracksResponse = z.infer<typeof tracksResponseSchema>;

export interface SfuClient {
  addTracks(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuResponse>;
  closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<SfuResponse>;
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
    const response = await this.request(
      "/sessions/new",
      "POST",
    );
    assertSfuResponse(response);
    const parsed = sessionResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new SfuRequestError(
        "sfu_session_invalid",
        "Realtime SFU did not return a session identifier.",
        502,
      );
    }
    return parsed.data.sessionId;
  }

  addTracks(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      "POST",
      body,
    );
  }

  closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<SfuResponse> {
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
    const response = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      "PUT",
      { sessionDescription: answer },
    );
    assertSfuResponse(response);
  }

  private async request(
    path: string,
    method: "POST" | "PUT",
    body?: Record<string, unknown>,
  ): Promise<SfuResponse> {
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

    return payload;
  }
}

export function sfuTrackMids(response: SfuResponse): string[] {
  if (!Array.isArray(response.tracks)) return [];
  return response.tracks.flatMap((value) => {
    const parsed = trackMidSchema.safeParse(value);
    return parsed.success ? [parsed.data.mid] : [];
  });
}

export function parseSfuTracksResponse(
  response: SfuResponse,
  operation: "publish" | "subscribe",
): SfuTracksResponse {
  assertTrackErrors(response, operation);
  const parsed = tracksResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new SfuRequestError(
      "sfu_response_invalid",
      `Realtime SFU returned an invalid ${operation} response. Reconnect and retry.`,
    );
  }
  return parsed.data;
}

export function parseSfuCloseResponse(response: SfuResponse) {
  assertTrackErrors(response, "close");
  const parsed = closeResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new SfuRequestError(
      "sfu_response_invalid",
      "Realtime SFU returned an invalid close response. Retry cleanup.",
    );
  }
  return parsed.data;
}

function assertTrackErrors(
  response: SfuResponse,
  operation: "publish" | "subscribe" | "close",
): void {
  assertSfuResponse(response);
  if (Array.isArray(response.tracks)) {
    for (const value of response.tracks) {
      const item = responseObjectSchema.safeParse(value);
      if (!item.success || !hasSfuError(item.data)) continue;
      if (operation === "close" && item.data.errorCode === "close_track_error") {
        continue;
      }
      throw sfuResponseError(
        item.data,
        `Realtime SFU ${operation} failed for a track. Retry with the request ID.`,
      );
    }
  }
}

function assertSfuResponse(response: SfuResponse): void {
  if (hasSfuError(response)) {
    throw sfuResponseError(
      response,
      "Realtime SFU could not complete the operation.",
    );
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
    const parsed = responseObjectSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
