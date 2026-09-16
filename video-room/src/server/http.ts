import type { ApiErrorBody } from "../shared/protocol";
import { RequestError } from "./auth";
import { SfuRequestError } from "./realtime";
import { SessionQueueError } from "./session-mutation-queue";
import type { RoomRpcError, RoomRpcResult } from "./video-room";

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store", "x-request-id": requestId },
    status,
  });
}

export function rpcResponse<T>(
  result: RoomRpcResult<T>,
  requestId: string,
  status = 200,
): Response {
  if (result.type === "ok")
    return jsonResponse(result.value, status, requestId);
  return jsonResponse(
    {
      error: {
        code: result.error.code,
        message: result.error.message,
        requestId,
        retryable: result.error.retryable,
      },
    } satisfies ApiErrorBody,
    result.error.status,
    requestId,
  );
}

export function errorResponse(error: unknown, requestId: string): Response {
  const expected = expectedRoomError(error, requestId);
  if (expected)
    return rpcResponse({ type: "error", error: expected }, requestId);
  console.error("video-room request failed", { requestId });
  return rpcResponse(
    {
      type: "error",
      error: {
        code: "internal_error",
        message: "The room operation failed. Retry with the request ID.",
        retryable: true,
        status: 500,
      },
    },
    requestId,
  );
}

export function expectedRoomError(
  error: unknown,
  requestId: string,
): RoomRpcError | undefined {
  if (error instanceof SfuRequestError) {
    console.error("Realtime SFU request failed", {
      code: error.code,
      ...(error.track?.mid ? { mid: error.track.mid } : {}),
      requestId,
      status: error.status,
      ...(error.track?.trackName ? { trackName: error.track.trackName } : {}),
    });
  }
  if (error instanceof RequestError || error instanceof SfuRequestError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  if (error instanceof SessionQueueError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: 409,
    };
  }
  return undefined;
}
