import { ContainerProxy } from "@cloudflare/containers";
import { Hono, type Context } from "hono";
import type { ZodType } from "zod";

import {
  assertSameOrigin,
  authenticateUser,
  type AuthenticatedPrincipal,
  RequestError,
  type AuthEnv,
} from "./server/auth";
import { GameContainer } from "./server/game-container";
import { ContextLogger } from "./server/logger";
import { proxyPublisherRequest } from "./server/publisher-proxy";
import type {
  ControlClaimRpcContext,
  ControlRpcContext,
  GameRpcContext,
  ViewerRpcContext,
} from "./server/rpc";
import {
  API_HEADER_VIEWER_CAPABILITY,
  API_HEADER_VIEWER_ID,
  PUBLISHER_HOST,
  type ApiErrorBody,
  type RpcResult,
} from "./shared/protocol";
import {
  capabilitySchema,
  contentLengthSchema,
  emptySearchSchema,
  jsonContentTypeSchema,
  uuidSchema,
  viewerJoinSchema,
  viewerTransportCompleteSchema,
} from "./shared/schemas";

export { ContainerProxy, GameContainer };

export const DEFAULT_SLOT = "default";

type WorkerEnv = Env & AuthEnv;
type App = {
  Bindings: WorkerEnv;
  Variables: {
    principal: AuthenticatedPrincipal;
    requestId: string;
  };
};

const MAX_BODY_BYTES = 1_100_000;
const app = new Hono<App>();
const log = new ContextLogger("worker");

GameContainer.outboundByHost = {
  [PUBLISHER_HOST]: proxyPublisherRequest,
};

app.use("/api/*", async (context, next) => {
  context.set("requestId", crypto.randomUUID());
  assertSameOrigin(context.req.raw);
  if (!emptySearchSchema.safeParse(new URL(context.req.url).search).success) {
    throw new RequestError(
      400,
      "query_invalid",
      "Cloud-gaming API routes do not accept query parameters.",
    );
  }
  context.set(
    "principal",
    await authenticateUser(context.req.raw, context.env),
  );
  await next();
});

app.get("/api/game", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).getSnapshot(gameContext(context, requestId)),
    requestId,
  );
});

app.post("/api/game/start", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).startGame(gameContext(context, requestId)),
    requestId,
    202,
  );
});

app.post("/api/game/stop", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).stopGame(gameContext(context, requestId)),
    requestId,
  );
});

app.post("/api/viewers", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).joinViewer(
      gameContext(context, requestId),
      await readJson(context.req.raw, viewerJoinSchema),
    ),
    requestId,
    201,
  );
});

app.post("/api/viewers/heartbeat", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).heartbeatViewer(
      viewerContext(context, requestId),
    ),
    requestId,
  );
});

app.post("/api/viewers/leave", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).leaveViewer(
      viewerContext(context, requestId),
    ),
    requestId,
  );
});

app.post("/api/viewers/datachannel-transport", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).establishViewerInputTransport(
      viewerContext(context, requestId),
    ),
    requestId,
    201,
  );
});

app.post("/api/viewers/datachannel-transport/complete", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).completeViewerInputTransport(
      viewerContext(context, requestId),
      await readJson(context.req.raw, viewerTransportCompleteSchema),
    ),
    requestId,
  );
});

app.post("/api/control", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).claimControl(
      claimContext(context, requestId),
    ),
    requestId,
  );
});

app.post("/api/control/release", async (context) => {
  const requestId = context.get("requestId");
  return rpcResponse(
    await gameContainer(context.env).releaseControl(
      controlContext(context, requestId),
    ),
    requestId,
  );
});

app.all("/api/*", () => {
  throw new RequestError(
    404,
    "route_not_found",
    "The cloud-gaming API operation does not exist.",
  );
});

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

app.onError((error, context) =>
  errorResponse(error, context.get("requestId") || crypto.randomUUID()),
);

export default app;

function gameContainer(env: WorkerEnv): DurableObjectStub<GameContainer> {
  return env.GAME_CONTAINER.getByName(DEFAULT_SLOT);
}

function gameContext(context: Context<App>, requestId: string): GameRpcContext {
  return {
    principal: context.get("principal"),
    requestId,
  };
}

function viewerContext(
  context: Context<App>,
  requestId: string,
): ViewerRpcContext {
  const request = context.req.raw;
  return {
    ...gameContext(context, requestId),
    viewerCapability: requiredHeader(
      request,
      API_HEADER_VIEWER_CAPABILITY,
      capabilitySchema,
      "viewer_capability_invalid",
    ),
    viewerId: requiredHeader(
      request,
      API_HEADER_VIEWER_ID,
      uuidSchema,
      "viewer_id_invalid",
    ),
  };
}

function controlContext(
  context: Context<App>,
  requestId: string,
): ControlRpcContext {
  return viewerContext(context, requestId);
}

function claimContext(
  context: Context<App>,
  requestId: string,
): ControlClaimRpcContext {
  return viewerContext(context, requestId);
}

async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  if (
    !jsonContentTypeSchema.safeParse(request.headers.get("content-type"))
      .success
  ) {
    throw new RequestError(
      415,
      "content_type_invalid",
      "Send the request as application/json.",
    );
  }
  const contentLength = contentLengthSchema.safeParse(
    request.headers.get("content-length"),
  );
  if (!contentLength.success || contentLength.data > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      "body_too_large",
      "The request body is too large.",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      "body_too_large",
      "The request body is too large.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestError(400, "json_invalid", "Send a valid JSON request.");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestError(
      400,
      "body_invalid",
      "The request body does not match this operation.",
    );
  }
  return result.data;
}

function requiredHeader<T>(
  request: Request,
  name: string,
  schema: ZodType<T>,
  code: string,
): T {
  const result = schema.safeParse(request.headers.get(name));
  if (!result.success) {
    throw new RequestError(
      403,
      code,
      "The supplied viewer capability is invalid.",
    );
  }
  return result.data;
}

function rpcResponse<T>(
  result: RpcResult<T>,
  requestId: string,
  status = 200,
): Response {
  if (result.type === "error") {
    return json(
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
  return json(result.value, status, requestId);
}

function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof RequestError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          retryable: error.retryable,
        },
      } satisfies ApiErrorBody,
      error.status,
      requestId,
    );
  }
  log.error("request failed", { request: { requestId } });
  return json(
    {
      error: {
        code: "internal_error",
        message: "The operation failed. Retry with the request ID.",
        requestId,
        retryable: true,
      },
    } satisfies ApiErrorBody,
    500,
    requestId,
  );
}

function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    status,
  });
}
