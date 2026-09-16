import type { z } from "zod";

import {
  API_HEADER_LOCAL_IDENTITY,
  API_HEADER_MEMBER_TOKEN,
  apiErrorBodySchema,
  joinResponseSchema,
  okResponseSchema,
  publishResponseSchema,
  roomSnapshotSchema,
  socketTicketResponseSchema,
  subscriptionResponseSchema,
  type PublishRequest,
  type JoinResponse,
  type PublishResponse,
  type RoomSnapshot,
  type SessionDescription,
  type SocketTicketResponse,
  type SubscriptionResponse,
} from "../shared/protocol";

export const CLIENT_REQUEST_TIMEOUT_MS = 15_000;
export const CLIENT_CLEANUP_REQUEST_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class RoomApi {
  memberToken?: string;

  constructor(
    private readonly roomId: string,
    private readonly localIdentity: string,
    private readonly requestTimeoutMs = CLIENT_REQUEST_TIMEOUT_MS,
  ) {}

  async join(
    clientId: string,
    displayName: string,
    memberToken: string,
    signal?: AbortSignal,
  ): Promise<JoinResponse> {
    const response = await this.request("join", joinResponseSchema, {
      body: { clientId, displayName, memberToken },
      method: "POST",
      signal,
      withToken: false,
    });
    this.memberToken = response.memberToken;
    return response;
  }

  async reconnect(
    clientId: string,
    displayName: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<JoinResponse> {
    const response = await this.request("reconnect", joinResponseSchema, {
      body: { clientId, displayName, requestId },
      method: "POST",
      signal,
    });
    this.memberToken = response.memberToken;
    return response;
  }

  snapshot(signal?: AbortSignal): Promise<RoomSnapshot> {
    return this.request("snapshot", roomSnapshotSchema, {
      method: "GET",
      signal,
    });
  }

  heartbeat(signal?: AbortSignal): Promise<RoomSnapshot> {
    return this.request("heartbeat", roomSnapshotSchema, {
      method: "POST",
      signal,
    });
  }

  issueSocketTicket(signal?: AbortSignal): Promise<SocketTicketResponse> {
    return this.request("socket-ticket", socketTicketResponseSchema, {
      method: "POST",
      signal,
    });
  }

  notificationSocketUrl(): string {
    const url = new URL(this.url("socket"), location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  publish(
    input: PublishRequest,
    signal?: AbortSignal,
  ): Promise<PublishResponse> {
    return this.request("publish", publishResponseSchema, {
      body: input,
      method: "POST",
      signal,
    });
  }

  subscribe(
    generation: number,
    mutationId: string,
    trackKeys: string[],
    signal?: AbortSignal,
  ): Promise<SubscriptionResponse> {
    return this.request("subscribe", subscriptionResponseSchema, {
      body: { generation, mutationId, trackKeys },
      method: "POST",
      signal,
    });
  }

  renegotiate(
    generation: number,
    mutationId: string,
    sessionDescription: SessionDescription,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return this.request("renegotiate", okResponseSchema, {
      body: { generation, mutationId, sessionDescription },
      method: "POST",
      signal,
    });
  }

  leave(signal?: AbortSignal): Promise<RoomSnapshot> {
    return this.request("leave", roomSnapshotSchema, {
      method: "POST",
      signal,
      timeoutMs: CLIENT_CLEANUP_REQUEST_TIMEOUT_MS,
    });
  }

  terminate(signal?: AbortSignal): Promise<RoomSnapshot> {
    return this.request("terminate", roomSnapshotSchema, {
      method: "POST",
      signal,
      timeoutMs: CLIENT_CLEANUP_REQUEST_TIMEOUT_MS,
    });
  }

  private async request<S extends z.ZodType>(
    action: string,
    schema: S,
    options: {
      body?: unknown;
      method: "GET" | "POST";
      signal?: AbortSignal;
      timeoutMs?: number;
      withToken?: boolean;
    },
  ): Promise<z.output<S>> {
    const bounded = boundedRequestSignal(
      options.signal,
      options.timeoutMs ?? this.requestTimeoutMs,
    );
    try {
      const response = await fetch(this.url(action), {
        body: options.body ? JSON.stringify(options.body) : undefined,
        headers: this.headers(options.withToken !== false),
        method: options.method,
        signal: bounded.signal,
      });
      const headerRequestId = response.headers.get("x-request-id") ?? undefined;
      const invalidResponse = () =>
        new ApiError(
          response.ok ? "response_invalid" : `http_${response.status}`,
          "The room returned an invalid response.",
          false,
          headerRequestId,
          response.status,
        );
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (bounded.signal.aborted) throw error;
        throw invalidResponse();
      }
      if (!response.ok) {
        const parsed = apiErrorBodySchema.safeParse(payload);
        if (!parsed.success) throw invalidResponse();
        const { error } = parsed.data;
        throw new ApiError(
          error.code,
          error.message,
          error.retryable === true,
          error.requestId ?? headerRequestId,
          response.status,
        );
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw invalidResponse();
      return parsed.data;
    } catch (error) {
      if (bounded.didTimeout() && !options.signal?.aborted) {
        throw new ApiError(
          "client_request_timed_out",
          "The room request timed out.",
          true,
        );
      }
      throw error;
    } finally {
      bounded.cleanup();
    }
  }

  private headers(withToken: boolean): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (isLocalhost()) {
      headers.set(API_HEADER_LOCAL_IDENTITY, this.localIdentity);
    }
    if (withToken && this.memberToken) {
      headers.set(API_HEADER_MEMBER_TOKEN, this.memberToken);
    }
    return headers;
  }

  private url(action: string): string {
    return `/api/rooms/${encodeURIComponent(this.roomId)}/${action}`;
  }
}

function boundedRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  cleanup(): void;
  didTimeout(): boolean;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("The room request timed out.", "TimeoutError"),
    );
  }, timeoutMs);
  return {
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
    didTimeout: () => timedOut,
    signal: controller.signal,
  };
}

function isLocalhost(): boolean {
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]"
  );
}
