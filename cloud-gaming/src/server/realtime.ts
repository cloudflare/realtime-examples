import { z, type ZodType } from "zod";

import type { SessionDescription } from "../shared/protocol";
import {
  dataChannelsResponseSchema,
  emptySfuResponseSchema,
  newSessionResponseSchema,
  sfuErrorEnvelopeSchema,
  tracksResponseSchema,
  transportResponseSchema,
  type SfuDataChannel,
  type SfuDataChannelsResponse,
  type SfuTrack,
  type SfuTracksResponse,
} from "./realtime-schemas";

export type {
  SfuDataChannel,
  SfuDataChannelsResponse,
  SfuTrack,
  SfuTracksResponse,
} from "./realtime-schemas";

export type RealtimeEnv = {
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_BEARER_TOKEN?: string;
};

export type SfuDataChannelTransportResponse = {
  dataChannel?: SfuDataChannel;
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: SessionDescription;
};

export type CloseBatchResult<Identifier> = {
  closed: Identifier[];
  failures: Array<{
    code: string;
    identifier: Identifier;
  }>;
};

export class SfuRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly resource?: {
    dataChannelName?: string;
    id?: number;
    mid?: string;
    trackName?: string;
  };

  constructor(
    code: string,
    message: string,
    status = 502,
    retryable?: boolean,
    resource?: SfuRequestError["resource"],
  ) {
    super(message);
    this.name = "SfuRequestError";
    this.code = sanitizeErrorIdentifier(code) ?? "sfu_error";
    this.status = normalizeStatus(status, 502);
    this.retryable = retryable ?? isRetryableSfuStatus(this.status);
    this.resource = resource;
  }
}

const bindingSchema = z.string().trim().min(1);
const responseObjectSchema = z.record(z.string(), z.unknown());
const ERROR_IDENTIFIER = /^[a-z0-9][a-z0-9_]{0,79}$/;

export class RealtimeSfuClient {
  private readonly appId: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly token: string;

  constructor(
    env: RealtimeEnv,
    private readonly fetcher: typeof fetch = (input, init) =>
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
      undefined,
      newSessionResponseSchema,
    );
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
      tracksResponseSchema,
    );
  }

  async establishDataChannels(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuDataChannelTransportResponse> {
    const response = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/establish`,
      "POST",
      body,
      transportResponseSchema,
    );
    return {
      dataChannel:
        response.dataChannel ??
        response.datachannel ??
        response.dataChannels?.[0],
      requiresImmediateRenegotiation: response.requiresImmediateRenegotiation,
      sessionDescription: response.sessionDescription,
    };
  }

  addDataChannels(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuDataChannelsResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/new`,
      "POST",
      body,
      dataChannelsResponseSchema,
    );
  }

  updateDataChannels(
    sessionId: string,
    body: Record<string, unknown>,
  ): Promise<SfuDataChannelsResponse> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/update`,
      "PUT",
      body,
      dataChannelsResponseSchema,
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
      emptySfuResponseSchema,
    );
  }

  async closeTracks(
    sessionId: string,
    mids: string[],
  ): Promise<CloseBatchResult<string>> {
    const requested = [...new Set(mids)];
    if (requested.length === 0) return { closed: [], failures: [] };

    let response: SfuTracksResponse;
    try {
      response = await this.request(
        `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
        "PUT",
        {
          force: true,
          tracks: requested.map((mid) => ({ mid })),
        },
        tracksResponseSchema,
      );
    } catch (error) {
      if (isAbsentResponse(error)) {
        return { closed: requested, failures: [] };
      }
      throw error;
    }

    if (response.requiresImmediateRenegotiation) {
      return failedClose(requested, "sfu_close_requires_renegotiation");
    }
    if (
      response.tracks.some(
        (track) =>
          hasSfuError(track) &&
          !isAlreadyAbsentItem(track) &&
          (!track.mid || !requested.includes(track.mid)),
      )
    ) {
      return failedClose(requested, "sfu_track_close_failed");
    }

    const byMid = new Map(
      response.tracks
        .filter((track): track is SfuTrack & { mid: string } =>
          Boolean(track.mid),
        )
        .map((track) => [track.mid, track]),
    );
    const closed: string[] = [];
    const failures: CloseBatchResult<string>["failures"] = [];
    for (const mid of requested) {
      const item = byMid.get(mid);
      if (!item) {
        failures.push({
          code: "sfu_close_result_missing",
          identifier: mid,
        });
      } else if (isAlreadyAbsentItem(item)) {
        closed.push(mid);
      } else if (hasSfuError(item)) {
        failures.push({
          code:
            sanitizeErrorIdentifier(item.errorCode) ?? "sfu_track_close_failed",
          identifier: mid,
        });
      } else {
        closed.push(mid);
      }
    }
    return { closed, failures };
  }

  async closeDataChannels(
    sessionId: string,
    ids: number[],
  ): Promise<CloseBatchResult<number>> {
    const requested = [...new Set(ids)];
    if (requested.length === 0) return { closed: [], failures: [] };

    let response: SfuDataChannelsResponse;
    try {
      response = await this.request(
        `/sessions/${encodeURIComponent(sessionId)}/datachannels/close`,
        "PUT",
        {
          dataChannels: requested.map((id) => ({ id })),
        },
        dataChannelsResponseSchema,
      );
    } catch (error) {
      if (isAbsentResponse(error)) {
        return { closed: requested, failures: [] };
      }
      throw error;
    }

    if (
      response.dataChannels.some(
        (channel) =>
          hasSfuError(channel) &&
          !isAlreadyAbsentItem(channel) &&
          (channel.id === undefined || !requested.includes(channel.id)),
      )
    ) {
      return failedClose(requested, "sfu_datachannel_close_failed");
    }

    const byId = new Map(
      response.dataChannels
        .filter(
          (channel): channel is SfuDataChannel & { id: number } =>
            channel.id !== undefined,
        )
        .map((channel) => [channel.id, channel]),
    );
    const closed: number[] = [];
    const failures: CloseBatchResult<number>["failures"] = [];
    for (const id of requested) {
      const item = byId.get(id);
      if (!item) {
        failures.push({
          code: "sfu_close_result_missing",
          identifier: id,
        });
      } else if (isAlreadyAbsentItem(item)) {
        closed.push(id);
      } else if (hasSfuError(item)) {
        failures.push({
          code:
            sanitizeErrorIdentifier(item.errorCode) ??
            "sfu_datachannel_close_failed",
          identifier: id,
        });
      } else {
        closed.push(id);
      }
    }
    return { closed, failures };
  }

  private async request<T>(
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown> | undefined,
    schema: ZodType<T>,
  ): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
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
        "Realtime SFU could not be reached.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.json().catch(() => undefined);
    const responseStatus = normalizeStatus(response.status, 502);
    if (!response.ok) {
      const error = sfuErrorEnvelopeSchema.safeParse(raw);
      throw responseError(
        error.success ? error.data : {},
        isRetryableSfuStatus(responseStatus)
          ? "Realtime SFU could not complete the operation."
          : "Realtime SFU rejected the operation.",
        responseStatus,
      );
    }
    if (!responseObjectSchema.safeParse(raw).success) {
      throw new SfuRequestError(
        "sfu_response_invalid",
        "Realtime SFU returned an unreadable response.",
      );
    }
    const envelope = sfuErrorEnvelopeSchema.safeParse(raw);
    if (envelope.success && hasSfuError(envelope.data)) {
      throw responseError(
        envelope.data,
        "Realtime SFU could not complete the operation.",
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new SfuRequestError(
        "sfu_response_invalid",
        "Realtime SFU returned an invalid response.",
      );
    }
    return parsed.data;
  }
}

export function assertTrackItemsSucceeded(
  response: SfuTracksResponse,
  operation: string,
): void {
  for (const track of response.tracks) {
    if (!hasSfuError(track)) continue;
    throw responseError(track, `Realtime SFU ${operation} failed for a track.`);
  }
}

export function assertDataChannelItemsSucceeded(
  response: SfuDataChannelsResponse | SfuDataChannelTransportResponse,
  operation: string,
): void {
  const channels =
    "dataChannels" in response
      ? response.dataChannels
      : response.dataChannel
        ? [response.dataChannel]
        : [];
  for (const channel of channels) {
    if (!hasSfuError(channel)) continue;
    throw responseError(
      channel,
      `Realtime SFU ${operation} failed for a DataChannel.`,
    );
  }
}

function requireBinding(value: unknown, name: string): string {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new SfuRequestError(
      "sfu_not_configured",
      `${name} is not configured on the Worker.`,
      503,
      false,
    );
  }
  return parsed.data;
}

function hasSfuError(value: {
  errorCode?: unknown;
  errorDescription?: unknown;
}): boolean {
  return (
    typeof value.errorCode === "string" ||
    typeof value.errorDescription === "string"
  );
}

function isAlreadyAbsentItem(value: { errorCode?: unknown }): boolean {
  return value.errorCode === "close_track_error";
}

function responseError(
  value: {
    dataChannelName?: unknown;
    errorCode?: unknown;
    id?: unknown;
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
    resourceLocator(value),
  );
}

function resourceLocator(value: {
  dataChannelName?: unknown;
  id?: unknown;
  mid?: unknown;
  trackName?: unknown;
}): SfuRequestError["resource"] {
  const parsed = z
    .object({
      dataChannelName: z.string().optional(),
      id: z.number().int().min(0).optional(),
      mid: z.string().optional(),
      trackName: z.string().optional(),
    })
    .safeParse(value);
  if (!parsed.success) return undefined;
  const { dataChannelName, id, mid, trackName } = parsed.data;
  return dataChannelName || id !== undefined || mid || trackName
    ? { dataChannelName, id, mid, trackName }
    : undefined;
}

function isAbsentResponse(error: unknown): boolean {
  return (
    error instanceof SfuRequestError &&
    (error.status === 404 || error.status === 410)
  );
}

function failedClose<Identifier>(
  identifiers: Identifier[],
  code: string,
): CloseBatchResult<Identifier> {
  return {
    closed: [],
    failures: identifiers.map((identifier) => ({ code, identifier })),
  };
}

function isRetryableSfuStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function normalizeStatus(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 400 && value! <= 599
    ? value!
    : fallback;
}

function sanitizeErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && ERROR_IDENTIFIER.test(value)
    ? value
    : undefined;
}
