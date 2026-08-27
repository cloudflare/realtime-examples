import {
  buildSfuDataChannel,
  getChannelProfile,
  type ChannelProfileId,
  type DataChannelLocation,
  type SfuDataChannel,
} from "./channel-config.ts";

const JSON_CONTENT_TYPE = "application/json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_CHANNEL_ALREADY_CLOSED_ERROR_CODE = "close_track_error";

type JsonRecord = Record<string, unknown>;

export type FetchImplementation = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface SessionDescription<
  Type extends RTCSdpType = RTCSdpType,
> {
  type: Type;
  sdp: string;
}

export interface CreateSessionResult {
  sessionId: string;
}

export interface EstablishTransportResult {
  requiresImmediateRenegotiation: true;
  sessionDescription: SessionDescription<"offer">;
  dataChannelId: number;
}

export interface RenegotiateResult {
  ok: true;
}

export interface CreateDataChannelOptions {
  sessionId: string;
  profileId: ChannelProfileId;
  location: DataChannelLocation;
  publisherSessionId?: string;
}

export type CreatedDataChannel = SfuDataChannel & {
  id: number;
  profile: ChannelProfileId;
};

export interface CreateDataChannelResult {
  dataChannel: CreatedDataChannel;
}

export interface CloseDataChannelsResult {
  closedIds: number[];
}

export interface SfuApiOperations {
  createSession(): Promise<CreateSessionResult>;
  establishDataChannelTransport(
    sessionId: string,
  ): Promise<EstablishTransportResult>;
  renegotiate(
    sessionId: string,
    sessionDescription: SessionDescription<"answer">,
  ): Promise<RenegotiateResult>;
  createDataChannel(
    options: CreateDataChannelOptions,
  ): Promise<CreateDataChannelResult>;
  closeDataChannels(
    sessionId: string,
    channelIds: readonly number[],
  ): Promise<CloseDataChannelsResult>;
}

interface SfuApiErrorOptions extends ErrorOptions {
  status?: number;
  upstreamStatus?: number;
  upstreamErrorCode?: string;
  upstreamErrorSubcode?: string;
}

interface SfuApiClientOptions {
  appId: string;
  token: string;
  apiBase?: string;
  fetchImpl?: FetchImplementation;
  requestTimeoutMs?: number;
}

interface RequestOptions {
  method: "POST" | "PUT";
  operation: string;
  body?: unknown;
}

export class SfuApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamStatus: number | undefined;
  readonly upstreamErrorCode: string | undefined;
  readonly upstreamErrorSubcode: string | undefined;

  constructor(
    code: string,
    message: string,
    options: SfuApiErrorOptions = {},
  ) {
    super(message, options);
    this.name = "SfuApiError";
    this.code = code;
    this.status = options.status ?? 502;
    this.upstreamStatus = options.upstreamStatus;
    this.upstreamErrorCode = options.upstreamErrorCode;
    this.upstreamErrorSubcode = options.upstreamErrorSubcode;
  }
}

export class SfuApiClient implements SfuApiOperations {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor({
    appId,
    token,
    apiBase = "https://rtc.live.cloudflare.com/v1",
    fetchImpl = (input, init) => globalThis.fetch(input, init),
    requestTimeoutMs = 15_000,
  }: SfuApiClientOptions) {
    if (typeof appId !== "string" || appId.length === 0) {
      throw new TypeError("REALTIME_SFU_APP_ID is required");
    }
    if (typeof token !== "string" || token.length === 0) {
      throw new TypeError("REALTIME_SFU_BEARER_TOKEN is required");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required");
    }

    this.baseUrl =
      `${apiBase.replace(/\/+$/, "")}/apps/${encodeURIComponent(appId)}`;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async createSession(): Promise<CreateSessionResult> {
    const payload = await this.request("/sessions/new", {
      method: "POST",
      operation: "Create Realtime SFU session",
    });
    const sessionId = requireReturnedSessionId(
      payload.sessionId,
      "Create Realtime SFU session",
    );
    return { sessionId };
  }

  async establishDataChannelTransport(
    sessionId: string,
  ): Promise<EstablishTransportResult> {
    requireSessionId(sessionId, "sessionId");
    const payload = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/establish`,
      {
        method: "POST",
        operation: "Establish DataChannel transport",
        body: {
          dataChannel: {
            location: "remote",
            dataChannelName: "server-events",
          },
        },
      },
    );

    if (payload.requiresImmediateRenegotiation !== true) {
      throw invalidResponse(
        "Establish DataChannel transport",
        "requiresImmediateRenegotiation was not true",
      );
    }

    const sessionDescription = requireSessionDescription(
      payload.sessionDescription,
      "offer",
      "Establish DataChannel transport",
    );
    const transportChannel = requireOptionalRecord(
      payload.dataChannel ?? payload.datachannel,
    );
    const dataChannelId = requireDataChannelId(
      transportChannel?.id,
      "Establish DataChannel transport",
    );

    return {
      requiresImmediateRenegotiation: true,
      sessionDescription,
      dataChannelId,
    };
  }

  async renegotiate(
    sessionId: string,
    sessionDescription: SessionDescription<"answer">,
  ): Promise<RenegotiateResult> {
    requireSessionId(sessionId, "sessionId");
    const answer = requireSessionDescription(
      sessionDescription,
      "answer",
      "Renegotiate Realtime SFU session request",
    );
    const payload = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      {
        method: "PUT",
        operation: "Renegotiate Realtime SFU session",
        body: { sessionDescription: answer },
      },
    );

    if (payload.sessionDescription !== undefined) {
      requireSessionDescription(
        payload.sessionDescription,
        undefined,
        "Renegotiate Realtime SFU session",
      );
    }
    return { ok: true };
  }

  async createDataChannel({
    sessionId,
    profileId,
    location,
    publisherSessionId,
  }: CreateDataChannelOptions): Promise<CreateDataChannelResult> {
    requireSessionId(sessionId, "sessionId");
    const profile = getChannelProfile(profileId);
    const requestedChannel = buildSfuDataChannel(
      profileId,
      location,
      publisherSessionId,
    );
    const payload = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/new`,
      {
        method: "POST",
        operation: `Create ${profile.label} DataChannel`,
        body: { dataChannels: [requestedChannel] },
      },
    );

    const dataChannels = requireArray(
      payload.dataChannels,
      `Create ${profile.label} DataChannel`,
      "dataChannels",
    );
    if (dataChannels.length !== 1) {
      throw invalidResponse(
        `Create ${profile.label} DataChannel`,
        "expected exactly one dataChannels result",
      );
    }

    const result = requireRecord(
      dataChannels[0],
      `Create ${profile.label} DataChannel result`,
    );
    throwForItemError(result, `Create ${profile.label} DataChannel`);
    const id = requireDataChannelId(
      result.id,
      `Create ${profile.label} DataChannel`,
    );
    if (
      result.location !== location ||
      result.dataChannelName !== profile.dataChannelName
    ) {
      throw invalidResponse(
        `Create ${profile.label} DataChannel`,
        "result did not match the requested location and name",
      );
    }

    return {
      dataChannel: {
        id,
        profile: profileId,
        ...requestedChannel,
      },
    };
  }

  async closeDataChannels(
    sessionId: string,
    channelIds: readonly number[],
  ): Promise<CloseDataChannelsResult> {
    requireSessionId(sessionId, "sessionId");
    const ids = requireCloseChannelIds(channelIds);
    const payload = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/close`,
      {
        method: "PUT",
        operation: "Close Realtime SFU DataChannels",
        body: {
          dataChannels: ids.map((id) => ({ id })),
        },
      },
    );

    const dataChannels = requireArray(
      payload.dataChannels,
      "Close Realtime SFU DataChannels",
      "dataChannels",
    );
    const closedIds = dataChannels.map((value) => {
      const result = requireRecord(
        value,
        "Close Realtime SFU DataChannel result",
      );
      const id = requireDataChannelId(
        result.id,
        "Close Realtime SFU DataChannel",
      );
      if (result.errorCode === DATA_CHANNEL_ALREADY_CLOSED_ERROR_CODE) {
        return id;
      }
      throwForItemError(result, "Close Realtime SFU DataChannel");
      return id;
    });

    for (const id of ids) {
      if (!closedIds.includes(id)) {
        throw invalidResponse(
          "Close Realtime SFU DataChannels",
          `response did not confirm DataChannel ${id}`,
        );
      }
    }
    return { closedIds: ids };
  }

  private async request(
    path: string,
    { method, operation, body }: RequestOptions,
  ): Promise<JsonRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: JSON_CONTENT_TYPE,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": JSON_CONTENT_TYPE,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SfuApiError(
        controller.signal.aborted ? "sfu_timeout" : "sfu_unreachable",
        controller.signal.aborted
          ? `${operation} did not receive a Realtime SFU response within ${this.requestTimeoutMs} ms. Retry after checking server network access.`
          : `${operation} could not reach Realtime SFU. Check server network access and retry.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith(JSON_CONTENT_TYPE)) {
      throw invalidResponse(
        operation,
        `expected application/json but received ${contentType || "no content type"}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw invalidResponse(operation, "response was not valid JSON", error);
    }
    const payloadRecord = requireRecord(payload, `${operation} response`);

    if (
      typeof payloadRecord.errorCode === "string" &&
      payloadRecord.errorCode.length > 0
    ) {
      throw upstreamFailure(
        operation,
        response.status,
        payloadRecord.errorCode,
        payloadRecord.errorSubcode,
      );
    }
    if (!response.ok) {
      throw upstreamFailure(operation, response.status);
    }
    return payloadRecord;
  }
}

function requireRecord(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(context, "expected a JSON object");
  }
  return value as JsonRecord;
}

function requireOptionalRecord(value: unknown): JsonRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, "DataChannel");
}

function requireArray(
  value: unknown,
  operation: string,
  field: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse(operation, `${field} was not an array`);
  }
  return value;
}

function requireSessionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new SfuApiError(
      "invalid_session_id",
      `${field} must be 1-128 letters, numbers, underscores, or hyphens`,
      { status: 400 },
    );
  }
  return value;
}

function requireReturnedSessionId(
  value: unknown,
  operation: string,
): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw invalidResponse(operation, "sessionId was missing or invalid");
  }
  return value;
}

function requireSessionDescription<
  Type extends "offer" | "answer",
>(
  value: unknown,
  expectedType: Type,
  operation: string,
): SessionDescription<Type>;
function requireSessionDescription(
  value: unknown,
  expectedType: undefined,
  operation: string,
): SessionDescription;
function requireSessionDescription(
  value: unknown,
  expectedType: "offer" | "answer" | undefined,
  operation: string,
): SessionDescription {
  const description = requireRecord(
    value,
    `${operation} sessionDescription`,
  );
  if (
    typeof description.type !== "string" ||
    (expectedType !== undefined && description.type !== expectedType)
  ) {
    throw invalidResponse(
      operation,
      expectedType
        ? `sessionDescription.type was not ${expectedType}`
        : "sessionDescription.type was missing",
    );
  }
  if (
    typeof description.sdp !== "string" ||
    description.sdp.length === 0
  ) {
    throw invalidResponse(operation, "sessionDescription.sdp was missing");
  }
  return {
    type: description.type as RTCSdpType,
    sdp: description.sdp,
  };
}

function requireDataChannelId(value: unknown, operation: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 65_534
  ) {
    throw invalidResponse(operation, "DataChannel id was invalid");
  }
  return value;
}

function requireCloseChannelIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new SfuApiError(
      "invalid_channel_ids",
      "channelIds must contain 1-8 application DataChannel IDs",
      { status: 400 },
    );
  }
  const ids = [...new Set(value)];
  for (const id of ids) {
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 1 ||
      id > 65_534
    ) {
      throw new SfuApiError(
        "invalid_channel_ids",
        "Every channelIds value must be an integer from 1 through 65534",
        { status: 400 },
      );
    }
  }
  return ids as number[];
}

function throwForItemError(item: JsonRecord, operation: string): void {
  if (typeof item.errorCode === "string" && item.errorCode.length > 0) {
    throw upstreamFailure(
      operation,
      200,
      item.errorCode,
      item.errorSubcode,
    );
  }
}

function invalidResponse(
  operation: string,
  detail: string,
  cause?: unknown,
): SfuApiError {
  return new SfuApiError(
    "invalid_sfu_response",
    `${operation} returned an invalid response: ${detail}.`,
    { cause },
  );
}

function upstreamFailure(
  operation: string,
  status: number,
  errorCode?: unknown,
  errorSubcode?: unknown,
): SfuApiError {
  const safeErrorCode = sanitizeErrorIdentifier(errorCode);
  const safeErrorSubcode = sanitizeErrorIdentifier(errorSubcode);
  const suffix = safeErrorCode ? ` (${safeErrorCode})` : "";
  const credentialHint =
    status === 401 || status === 403
      ? " Check REALTIME_SFU_APP_ID and REALTIME_SFU_BEARER_TOKEN on the server."
      : "";
  return new SfuApiError(
    "sfu_request_failed",
    `${operation} was rejected by Realtime SFU with HTTP ${status}${suffix}.${credentialHint}`,
    {
      upstreamStatus: status,
      ...(safeErrorCode === undefined
        ? {}
        : { upstreamErrorCode: safeErrorCode }),
      ...(safeErrorSubcode === undefined
        ? {}
        : { upstreamErrorSubcode: safeErrorSubcode }),
    },
  );
}

function sanitizeErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value
    : undefined;
}
