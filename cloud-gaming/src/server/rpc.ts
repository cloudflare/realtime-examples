import type { RpcError } from "../shared/protocol";
import { RequestError, type AuthenticatedPrincipal } from "./auth";
import { ContextLogger } from "./logger";
import { SfuRequestError } from "./realtime";

const log = new ContextLogger("sfu");

export type GameRpcContext = {
  principal: AuthenticatedPrincipal;
  requestId: string;
};

export type ViewerRpcContext = GameRpcContext & {
  viewerCapability: string;
  viewerId: string;
};

export type OperatorRpcContext = GameRpcContext;

export type ControlClaimRpcContext = ViewerRpcContext;

export type ControlRpcContext = ViewerRpcContext;

export type PublisherRpcContext = {
  requestId: string;
  runGeneration: number;
  runId: string;
};

export function expectedRpcError(
  error: unknown,
  requestId: string,
): RpcError | undefined {
  if (error instanceof RequestError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  if (error instanceof SfuRequestError) {
    log.error(
      "request failed",
      { request: { requestId } },
      {
        code: error.code,
        dataChannelId: error.resource?.id,
        dataChannelName: error.resource?.dataChannelName,
        mid: error.resource?.mid,
        status: error.status,
        trackName: error.resource?.trackName,
      },
    );
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  return undefined;
}
