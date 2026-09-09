import type { ZodType } from "zod";

import {
  API_HEADER_LOCAL_IDENTITY,
  API_HEADER_VIEWER_CAPABILITY,
  API_HEADER_VIEWER_ID,
  type ControlClaimResponse,
  type ControlLeaseResponse,
  type GameSnapshot,
  type SessionDescription,
  type ViewerHeartbeatResponse,
  type ViewerInputResponse,
  type ViewerJoinResponse,
  type ViewerLeaveResponse,
  type ViewerTransportResponse,
} from "../shared/protocol";
import {
  apiErrorResponseSchema,
  controlClaimResponseSchema,
  controlLeaseResponseSchema,
  gameSnapshotResponseSchema,
  viewerHeartbeatResponseSchema,
  viewerInputResponseSchema,
  viewerJoinResponseSchema,
  viewerLeaveResponseSchema,
  viewerTransportResponseSchema,
} from "../shared/schemas";

const JSON_CONTENT_TYPE = "application/json";
const REQUEST_TIMEOUT_MS = 12_000;

export type ViewerCredentials = {
  viewerCapability: string;
  viewerId: string;
};

type RequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  keepalive?: boolean;
  method?: "GET" | "POST";
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiRequestError";
  }
}

export class CloudGamingApi {
  getGame(): Promise<GameSnapshot> {
    return this.request("/api/game", {}, gameSnapshotResponseSchema);
  }

  startGame(): Promise<GameSnapshot> {
    return this.request(
      "/api/game/start",
      {
        method: "POST",
      },
      gameSnapshotResponseSchema,
    );
  }

  stopGame(): Promise<GameSnapshot> {
    return this.request(
      "/api/game/stop",
      {
        method: "POST",
      },
      gameSnapshotResponseSchema,
    );
  }

  joinViewer(
    sessionDescription: SessionDescription,
  ): Promise<ViewerJoinResponse> {
    return this.request(
      "/api/viewers",
      {
        body: { sessionDescription },
        method: "POST",
      },
      viewerJoinResponseSchema,
    );
  }

  heartbeatViewer(
    viewer: ViewerCredentials,
  ): Promise<ViewerHeartbeatResponse> {
    return this.request(
      "/api/viewers/heartbeat",
      {
        headers: viewerHeaders(viewer),
        method: "POST",
      },
      viewerHeartbeatResponseSchema,
    );
  }

  leaveViewer(
    viewer: ViewerCredentials,
    keepalive = false,
  ): Promise<ViewerLeaveResponse> {
    return this.request(
      "/api/viewers/leave",
      {
        headers: viewerHeaders(viewer),
        keepalive,
        method: "POST",
      },
      viewerLeaveResponseSchema,
    );
  }

  establishViewerDataChannels(
    viewer: ViewerCredentials,
  ): Promise<ViewerTransportResponse> {
    return this.request(
      "/api/viewers/datachannel-transport",
      {
        headers: viewerHeaders(viewer),
        method: "POST",
      },
      viewerTransportResponseSchema,
    );
  }

  completeViewerDataChannels(
    viewer: ViewerCredentials,
    sessionDescription: SessionDescription,
  ): Promise<ViewerInputResponse> {
    return this.request(
      "/api/viewers/datachannel-transport/complete",
      {
        body: { sessionDescription },
        headers: viewerHeaders(viewer),
        method: "POST",
      },
      viewerInputResponseSchema,
    );
  }

  claimControl(viewer: ViewerCredentials): Promise<ControlClaimResponse> {
    return this.request(
      "/api/control",
      {
        headers: viewerHeaders(viewer),
        method: "POST",
      },
      controlClaimResponseSchema,
    );
  }

  releaseControl(
    viewer: ViewerCredentials,
    keepalive = false,
  ): Promise<ControlLeaseResponse> {
    return this.request(
      "/api/control/release",
      {
        headers: viewerHeaders(viewer),
        keepalive,
        method: "POST",
      },
      controlLeaseResponseSchema,
    );
  }

  private async request<T>(
    path: string,
    options: RequestOptions,
    schema: ZodType<T>,
  ): Promise<T> {
    const headers = new Headers({
      ...browserIdentityHeaders(),
      ...options.headers,
    });
    headers.set("Accept", JSON_CONTENT_TYPE);

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", JSON_CONTENT_TYPE);
      body = JSON.stringify(options.body);
    }

    const controller = options.keepalive ? undefined : new AbortController();
    const timeout =
      controller === undefined
        ? undefined
        : window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(path, {
        body,
        cache: "no-store",
        credentials: "same-origin",
        headers,
        keepalive: options.keepalive,
        method: options.method ?? "GET",
        signal: controller?.signal,
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new ApiRequestError(
          "The request timed out. Retry the connection.",
          0,
          "request_timeout",
          true,
          undefined,
          { cause: error },
        );
      }
      throw new ApiRequestError(
        "The browser could not reach the cloud-gaming Worker.",
        0,
        "worker_unreachable",
        true,
        undefined,
        { cause: error },
      );
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length === 0 ? null : JSON.parse(text);
    } catch (error) {
      throw invalidResponse(response.status, error);
    }

    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(payload);
      throw new ApiRequestError(
        parsed.success && parsed.data.error.message
          ? parsed.data.error.message
          : `The Worker rejected the request with HTTP ${response.status}.`,
        response.status,
        parsed.success && parsed.data.error.code
          ? parsed.data.error.code
          : "request_failed",
        parsed.success && parsed.data.error.retryable === true,
        parsed.success ? parsed.data.error.requestId : undefined,
      );
    }

    try {
      return schema.parse(payload);
    } catch (error) {
      throw invalidResponse(response.status, error);
    }
  }
}

function browserIdentityHeaders(): Record<string, string> {
  return isLoopbackHost(window.location.hostname)
    ? { [API_HEADER_LOCAL_IDENTITY]: "developer" }
    : {};
}

function viewerHeaders(viewer: ViewerCredentials): Record<string, string> {
  return {
    [API_HEADER_VIEWER_CAPABILITY]: viewer.viewerCapability,
    [API_HEADER_VIEWER_ID]: viewer.viewerId,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function invalidResponse(status: number, cause: unknown): ApiRequestError {
  return new ApiRequestError(
    "The Worker returned an unexpected response.",
    status,
    "response_invalid",
    false,
    undefined,
    { cause },
  );
}
