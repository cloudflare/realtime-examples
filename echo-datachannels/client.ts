import {
  buildBrowserDataChannelOptions,
  getChannelProfile,
  type ChannelProfileId,
  type DataChannelLocation,
  type SfuDataChannel,
} from "./channel-config.ts";

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

type FetchImplementation = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface ExampleErrorOptions extends ErrorOptions {}

interface ExampleApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchImplementation;
  requestTimeoutMs?: number;
}

interface SessionDescription<Type extends "offer" | "answer"> {
  type: Type;
  sdp: string;
}

interface ExampleCreateDataChannelOptions {
  sessionId: string;
  profile: ChannelProfileId;
  location: DataChannelLocation;
  publisherSessionId?: string;
}

export type ExampleDataChannel = SfuDataChannel & {
  id: number;
  profile: ChannelProfileId;
};

interface ExampleRequestOptions<Result> {
  method: "POST" | "PUT";
  body: JsonRecord;
  action: string;
  validate: (payload: JsonRecord) => Result;
}

export interface DataChannelLike extends EventTarget {
  readonly label: string;
  readonly readyState: RTCDataChannelState;
  close(): void;
  send(data: string): void;
}

export interface PeerConnectionLike extends EventTarget {
  readonly connectionState: RTCPeerConnectionState;
  close(): void;
}

export interface RemoteDataChannelGroup {
  sessionId: string | null;
  channelIds: readonly number[];
}

export interface TeardownApi {
  closeDataChannels(
    sessionId: string,
    channelIds: readonly number[],
  ): Promise<{ closedIds: readonly number[] }>;
}

interface TeardownManagerOptions {
  api: TeardownApi;
  getRemoteGroups: () => readonly RemoteDataChannelGroup[];
  getDataChannels: () => readonly DataChannelLike[];
  getPeerConnections: () => readonly PeerConnectionLike[];
}

export interface TeardownResult {
  alreadyClosed: boolean;
  remoteSessionsClosed: number;
}

interface WaitOptions {
  timeoutMs?: number;
  label?: string;
}

interface WaitForStateOptions<State extends string> {
  target: EventTarget;
  eventName: string;
  additionalEvents?: readonly string[];
  timeoutMs: number;
  label: string;
  getState: () => State;
  isReady: (state: State) => boolean;
  isFailed: (state: State) => boolean;
}

export class ExampleError extends Error {
  readonly code: string;

  constructor(
    code: string,
    message: string,
    options: ExampleErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ExampleError";
    this.code = code;
  }
}

export class ExampleApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor({
    baseUrl = "",
    fetchImpl = (input, init) => globalThis.fetch(input, init),
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  }: ExampleApiOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async createSession(): Promise<{ sessionId: string }> {
    return this.request("/api/sessions", {
      method: "POST",
      body: {},
      action: "Create a Realtime SFU session",
      validate(payload) {
        const sessionId = requireSessionId(payload.sessionId, "sessionId");
        return { sessionId };
      },
    });
  }

  async establishTransport(
    sessionId: string,
  ): Promise<{
    requiresImmediateRenegotiation: true;
    dataChannelId: number;
    sessionDescription: SessionDescription<"offer">;
  }> {
    requireSessionId(sessionId, "sessionId");
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/datachannel-transport`,
      {
        method: "POST",
        body: {},
        action: "Establish the DataChannel transport",
        validate(payload) {
          if (payload.requiresImmediateRenegotiation !== true) {
            throw invalidServerResponse(
              "requiresImmediateRenegotiation was not true",
            );
          }
          const dataChannelId = requireDataChannelId(
            payload.dataChannelId,
            "dataChannelId",
          );
          return {
            requiresImmediateRenegotiation: true,
            dataChannelId,
            sessionDescription: requireSessionDescription(
              payload.sessionDescription,
              "offer",
            ),
          };
        },
      },
    );
  }

  async renegotiate(
    sessionId: string,
    sessionDescription: SessionDescription<"answer">,
  ): Promise<{ ok: true }> {
    requireSessionId(sessionId, "sessionId");
    const answer = requireSessionDescription(sessionDescription, "answer");
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      {
        method: "PUT",
        body: { sessionDescription: answer },
        action: "Complete DataChannel transport negotiation",
        validate(payload) {
          if (payload.ok !== true) {
            throw invalidServerResponse("renegotiation was not confirmed");
          }
          return { ok: true };
        },
      },
    );
  }

  async createDataChannel({
    sessionId,
    profile,
    location,
    publisherSessionId,
  }: ExampleCreateDataChannelOptions): Promise<{
    dataChannel: ExampleDataChannel;
  }> {
    requireSessionId(sessionId, "sessionId");
    const expectedProfile = getChannelProfile(profile);

    const body: JsonRecord = { profile, location };
    if (location === "remote") {
      body.publisherSessionId = requireSessionId(
        publisherSessionId,
        "publisherSessionId",
      );
    }

    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/datachannels`,
      {
        method: "POST",
        body,
        action: `Create ${expectedProfile.label} ${location} DataChannel`,
        validate(payload) {
          const dataChannel = requireRecord(
            payload.dataChannel,
            "dataChannel",
          );
          requireDataChannelId(dataChannel.id, "dataChannel.id");
          if (
            dataChannel.profile !== profile ||
            dataChannel.location !== location ||
            dataChannel.dataChannelName !==
              expectedProfile.dataChannelName
          ) {
            throw invalidServerResponse(
              "DataChannel response did not match the requested profile",
            );
          }
          return {
            dataChannel: dataChannel as unknown as ExampleDataChannel,
          };
        },
      },
    );
  }

  async closeDataChannels(
    sessionId: string,
    channelIds: readonly number[],
  ): Promise<{ closedIds: number[] }> {
    requireSessionId(sessionId, "sessionId");
    const expectedIds = requireChannelIds(channelIds);
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/datachannels/close`,
      {
        method: "PUT",
        body: { channelIds: expectedIds },
        action: "Close Realtime SFU DataChannels",
        validate(payload) {
          const closedIds = requireChannelIds(payload.closedIds);
          for (const id of expectedIds) {
            if (!closedIds.includes(id)) {
              throw invalidServerResponse(
                `server did not confirm DataChannel ${id} was closed`,
              );
            }
          }
          return { closedIds };
        },
      },
    );
  }

  private async request<Result>(
    path: string,
    {
      method,
      body,
      action,
      validate,
    }: ExampleRequestOptions<Result>,
  ): Promise<Result> {
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
          "Content-Type": JSON_CONTENT_TYPE,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExampleError(
          "server_timeout",
          `${action} did not receive a response within ${this.requestTimeoutMs} ms. Retry or inspect the local server terminal.`,
          { cause: error },
        );
      }
      throw new ExampleError(
        "server_unreachable",
        `${action} could not reach the local example server. Confirm npm start is still running.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith(JSON_CONTENT_TYPE)) {
      throw invalidServerResponse(
        `${action} expected application/json but received ${contentType || "no content type"}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw invalidServerResponse(
        `${action} returned malformed JSON`,
        error,
      );
    }
    const payloadRecord = requireRecord(payload, `${action} response`);

    if (!response.ok) {
      const publicError = requireOptionalPublicError(payloadRecord.error);
      throw new ExampleError(
        publicError.code,
        `${action} failed: ${publicError.message}`,
      );
    }

    return validate(payloadRecord);
  }
}

export function waitForPeerConnectionConnected(
  peerConnection: PeerConnectionLike,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = "PeerConnection",
  }: WaitOptions = {},
): Promise<RTCPeerConnectionState> {
  return waitForState({
    target: peerConnection,
    eventName: "connectionstatechange",
    timeoutMs,
    label,
    getState: () => peerConnection.connectionState,
    isReady: (state) => state === "connected",
    isFailed: (state) => state === "failed" || state === "closed",
  });
}

export function waitForDataChannelOpen(
  dataChannel: DataChannelLike,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    label = `DataChannel ${dataChannel.label || ""}`.trim(),
  }: WaitOptions = {},
): Promise<RTCDataChannelState> {
  return waitForState({
    target: dataChannel,
    eventName: "statechange",
    additionalEvents: ["open", "close", "error"],
    timeoutMs,
    label,
    getState: () => dataChannel.readyState,
    isReady: (state) => state === "open",
    isFailed: (state) => state === "closing" || state === "closed",
  });
}

export function sendJsonMessage(
  dataChannel: DataChannelLike | null | undefined,
  payload: unknown,
  label = "DataChannel",
): void {
  if (dataChannel?.readyState !== "open") {
    throw new ExampleError(
      "datachannel_not_open",
      `${label} is not open. Connect the example again before sending.`,
    );
  }
  dataChannel.send(JSON.stringify(payload));
}

export async function waitForSetupOperations(
  operations: readonly Promise<unknown>[],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected",
  );
  if (failures.length === 1) {
    throw failures[0]?.reason;
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Multiple setup operations failed.",
    );
  }
}

export async function teardownAfterSetup<Result>(
  setupOperation: Promise<unknown> | null,
  teardown: () => Promise<Result>,
): Promise<Result> {
  if (setupOperation) {
    try {
      await setupOperation;
    } catch {
      // Failure cleanup uses the same teardown manager after setup settles.
    }
  }
  return teardown();
}

export function createBrowserChannelWithTrackedId<Channel>(
  channelIds: Set<number>,
  channelId: number,
  createChannel: () => Channel,
): Channel {
  channelIds.add(channelId);
  return createChannel();
}

export class TeardownManager {
  private readonly api: TeardownApi;
  private readonly getRemoteGroups: () => readonly RemoteDataChannelGroup[];
  private readonly getDataChannels: () => readonly DataChannelLike[];
  private readonly getPeerConnections: () => readonly PeerConnectionLike[];
  private readonly closedRemoteChannelIds = new Map<string, Set<number>>();
  private readonly closedDataChannels = new WeakSet<DataChannelLike>();
  private readonly closedPeerConnections = new WeakSet<PeerConnectionLike>();
  private inFlight: Promise<TeardownResult> | null = null;

  constructor({
    api,
    getRemoteGroups,
    getDataChannels,
    getPeerConnections,
  }: TeardownManagerOptions) {
    this.api = api;
    this.getRemoteGroups = getRemoteGroups;
    this.getDataChannels = getDataChannels;
    this.getPeerConnections = getPeerConnections;
  }

  teardown(): Promise<TeardownResult> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const operation = this.runTeardown();
    this.inFlight = operation;
    void operation.then(
      () => {
        if (this.inFlight === operation) {
          this.inFlight = null;
        }
      },
      () => {
        if (this.inFlight === operation) {
          this.inFlight = null;
        }
      },
    );
    return operation;
  }

  private async runTeardown(): Promise<TeardownResult> {
    const wasAlreadyClosed = this.isFullyClosed();
    const errors: unknown[] = [];

    for (const group of this.getRemoteGroups()) {
      if (!group.sessionId) {
        continue;
      }
      const closedChannelIds =
        this.closedRemoteChannelIds.get(group.sessionId) ?? new Set<number>();
      const channelIds = [...new Set(group.channelIds)].filter(
        (id) => !closedChannelIds.has(id),
      );
      if (channelIds.length === 0) {
        continue;
      }

      try {
        await this.api.closeDataChannels(group.sessionId, channelIds);
        channelIds.forEach((id) => closedChannelIds.add(id));
        this.closedRemoteChannelIds.set(
          group.sessionId,
          closedChannelIds,
        );
      } catch (error) {
        errors.push(error);
      }
    }

    for (const dataChannel of this.getDataChannels()) {
      if (this.closedDataChannels.has(dataChannel)) {
        continue;
      }
      try {
        if (dataChannel.readyState !== "closed") {
          dataChannel.close();
        }
        this.closedDataChannels.add(dataChannel);
      } catch (error) {
        errors.push(error);
      }
    }

    for (const peerConnection of this.getPeerConnections()) {
      if (this.closedPeerConnections.has(peerConnection)) {
        continue;
      }
      try {
        if (peerConnection.connectionState !== "closed") {
          peerConnection.close();
        }
        this.closedPeerConnections.add(peerConnection);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Teardown closed local WebRTC objects, but one or more cleanup requests failed. Retry teardown.",
      );
    }

    return {
      alreadyClosed: wasAlreadyClosed,
      remoteSessionsClosed: this.countClosedRemoteSessions(),
    };
  }

  isFullyClosed(): boolean {
    const remoteClosed = this.getRemoteGroups().every(
      (group) =>
        !group.sessionId ||
        group.channelIds.every((id) =>
          this.closedRemoteChannelIds.get(group.sessionId!)?.has(id),
        ),
    );
    const channelsClosed = this.getDataChannels().every((channel) =>
      this.closedDataChannels.has(channel),
    );
    const connectionsClosed = this.getPeerConnections().every((connection) =>
      this.closedPeerConnections.has(connection),
    );
    return remoteClosed && channelsClosed && connectionsClosed;
  }

  private countClosedRemoteSessions(): number {
    const sessionChannelIds = new Map<string, Set<number>>();
    for (const group of this.getRemoteGroups()) {
      if (!group.sessionId) {
        continue;
      }
      const channelIds =
        sessionChannelIds.get(group.sessionId) ?? new Set<number>();
      group.channelIds.forEach((id) => channelIds.add(id));
      sessionChannelIds.set(group.sessionId, channelIds);
    }

    let count = 0;
    for (const [sessionId, channelIds] of sessionChannelIds) {
      if (
        channelIds.size > 0 &&
        [...channelIds].every((id) =>
          this.closedRemoteChannelIds.get(sessionId)?.has(id),
        )
      ) {
        count += 1;
      }
    }
    return count;
  }
}

export { buildBrowserDataChannelOptions };

function waitForState<State extends string>({
  target,
  eventName,
  additionalEvents = [],
  timeoutMs,
  label,
  getState,
  isReady,
  isFailed,
}: WaitForStateOptions<State>): Promise<State> {
  const initialState = getState();
  if (isReady(initialState)) {
    return Promise.resolve(initialState);
  }
  if (isFailed(initialState)) {
    return Promise.reject(
      new ExampleError(
        "webrtc_state_failed",
        `${label} entered ${initialState} before it became ready.`,
      ),
    );
  }

  return new Promise<State>((resolvePromise, rejectPromise) => {
    const events = [eventName, ...additionalEvents];
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const event of events) {
        target.removeEventListener(event, onStateChange);
      }
    };
    const finishWithError = (message: string): void => {
      cleanup();
      rejectPromise(new ExampleError("webrtc_state_failed", message));
    };
    const onStateChange = (): void => {
      const state = getState();
      if (isReady(state)) {
        cleanup();
        resolvePromise(state);
      } else if (isFailed(state)) {
        finishWithError(`${label} entered ${state} before it became ready.`);
      }
    };
    const timer = setTimeout(() => {
      finishWithError(
        `${label} did not become ready within ${timeoutMs} ms. Check browser WebRTC diagnostics and network access.`,
      );
    }, timeoutMs);

    for (const event of events) {
      target.addEventListener(event, onStateChange);
    }
    onStateChange();
  });
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidServerResponse(`${field} was not a JSON object`);
  }
  return value as JsonRecord;
}

function requireSessionId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value)
  ) {
    throw invalidServerResponse(`${field} was not a valid session ID`);
  }
  return value;
}

function requireDataChannelId(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 65_534
  ) {
    throw invalidServerResponse(
      `${field} was not a valid DataChannel ID`,
    );
  }
  return value;
}

function requireChannelIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw invalidServerResponse(
      "closedIds must contain 1-8 DataChannel IDs",
    );
  }
  const ids = [...new Set(value)];
  ids.forEach((id, index) => {
    requireDataChannelId(id, `closedIds[${index}]`);
    if (id === 0) {
      throw invalidServerResponse(
        `closedIds[${index}] was the reserved transport DataChannel ID`,
      );
    }
  });
  return ids as number[];
}

function requireSessionDescription<Type extends "offer" | "answer">(
  value: unknown,
  expectedType: Type,
): SessionDescription<Type> {
  const description = requireRecord(value, "sessionDescription");
  if (description.type !== expectedType) {
    throw invalidServerResponse(
      `sessionDescription.type was not ${expectedType}`,
    );
  }
  if (
    typeof description.sdp !== "string" ||
    description.sdp.length === 0
  ) {
    throw invalidServerResponse("sessionDescription.sdp was missing");
  }
  return {
    type: expectedType,
    sdp: description.sdp,
  };
}

function requireOptionalPublicError(value: unknown): {
  code: string;
  message: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      code: "request_failed",
      message: "The server returned an error without actionable JSON details.",
    };
  }
  const error = value as JsonRecord;
  return {
    code:
      typeof error.code === "string" && error.code.length > 0
        ? error.code
        : "request_failed",
    message:
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "The server returned an error without actionable JSON details.",
  };
}

function invalidServerResponse(
  detail: string,
  cause?: unknown,
): ExampleError {
  return new ExampleError(
    "invalid_server_response",
    `The local example server returned an invalid response: ${detail}.`,
    { cause },
  );
}
