import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Hono, type Context } from "hono";
import type { ZodType } from "zod";

import { PUBLISHER_API_PREFIX, type RpcResult } from "../shared/protocol";
import {
  contentLengthSchema,
  emptySearchSchema,
  jsonContentTypeSchema,
  publisherEmptySchema,
  publisherPublishSchema,
  publisherRegisterSchema,
  publisherRouteParamsSchema,
  publisherTransportCompleteSchema,
} from "../shared/schemas";
import type { GameContainer } from "./game-container";
import { ContextLogger } from "./logger";
import type { PublisherRpcContext } from "./rpc";

type ProxyEnv = Env & {
  GAME_CONTAINER: DurableObjectNamespace<GameContainer>;
};
type PublisherApp = {
  Bindings: ProxyEnv;
  Variables: {
    requestId: string;
  };
};

const MAX_BODY_BYTES = 1_100_000;
const ROUTE = `${PUBLISHER_API_PREFIX}/:runId/generations/:generation/publisher`;
const log = new ContextLogger("publisher-proxy");

export function proxyPublisherRequest(
  request: Request,
  env: ProxyEnv,
  outboundContext: OutboundHandlerContext,
): Promise<Response> | Response {
  if (outboundContext.className !== "GameContainer") {
    return publisherError(
      500,
      "publisher_container_invalid",
      "The publisher container class is not supported.",
      crypto.randomUUID(),
    );
  }
  if (request.method !== "POST") {
    return publisherError(
      405,
      "method_not_allowed",
      "Publisher signaling uses POST requests.",
      crypto.randomUUID(),
    );
  }
  return publisherRouter(outboundContext).fetch(request, env);
}

function publisherRouter(
  outboundContext: OutboundHandlerContext,
): Hono<PublisherApp> {
  const app = new Hono<PublisherApp>();

  app.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    if (!emptySearchSchema.safeParse(new URL(context.req.url).search).success) {
      throw new PublisherRequestError(
        400,
        "query_invalid",
        "Publisher signaling does not accept query parameters.",
      );
    }
    if (
      !jsonContentTypeSchema.safeParse(context.req.header("content-type"))
        .success
    ) {
      throw new PublisherRequestError(
        415,
        "content_type_invalid",
        "Publisher signaling requires application/json.",
      );
    }
    await next();
  });

  app.post(`${ROUTE}/register`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    return rpcResponse(
      await target.stub.registerPublisher(
        target.context,
        await readJson(context.req.raw, publisherRegisterSchema),
      ),
      requestId,
      201,
    );
  });

  app.post(`${ROUTE}/publish`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    return rpcResponse(
      await target.stub.publishMedia(
        target.context,
        await readJson(context.req.raw, publisherPublishSchema),
      ),
      requestId,
    );
  });

  app.post(`${ROUTE}/heartbeat`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    await readJson(context.req.raw, publisherEmptySchema);
    return rpcResponse(
      await target.stub.publisherHeartbeat(target.context),
      requestId,
    );
  });

  app.post(`${ROUTE}/datachannels/establish`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    await readJson(context.req.raw, publisherEmptySchema);
    return rpcResponse(
      await target.stub.establishPublisherDataChannels(target.context),
      requestId,
    );
  });

  app.post(`${ROUTE}/datachannels/complete`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    return rpcResponse(
      await target.stub.completePublisherDataChannels(
        target.context,
        await readJson(context.req.raw, publisherTransportCompleteSchema),
      ),
      requestId,
    );
  });

  app.post(`${ROUTE}/controller/poll`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    await readJson(context.req.raw, publisherEmptySchema);
    return rpcResponse(
      await target.stub.pollPublisherController(target.context),
      requestId,
    );
  });

  app.post(`${ROUTE}/stop`, async (context) => {
    const requestId = context.get("requestId");
    const target = publisherTarget(context, outboundContext);
    await readJson(context.req.raw, publisherEmptySchema);
    return rpcResponse(
      await target.stub.publisherStop(target.context),
      requestId,
    );
  });

  app.notFound((context) =>
    publisherError(
      404,
      "route_not_found",
      "The publisher operation does not exist.",
      context.get("requestId") || crypto.randomUUID(),
    ),
  );

  app.onError((error, context) => {
    const requestId = context.get("requestId") || crypto.randomUUID();
    if (error instanceof PublisherRequestError) {
      return publisherError(error.status, error.code, error.message, requestId);
    }
    log.error("request failed", { request: { requestId } });
    return publisherError(
      500,
      "internal_error",
      "The publisher operation failed. Retry with the request ID.",
      requestId,
      true,
    );
  });

  return app;
}

function publisherTarget(
  context: Context<PublisherApp>,
  outboundContext: OutboundHandlerContext,
): {
  context: PublisherRpcContext;
  stub: DurableObjectStub<GameContainer>;
} {
  const params = publisherRouteParamsSchema.safeParse(context.req.param());
  if (!params.success) {
    throw new PublisherRequestError(
      404,
      "route_not_found",
      "The publisher operation does not exist.",
    );
  }
  const id = context.env.GAME_CONTAINER.idFromString(
    outboundContext.containerId,
  );
  return {
    context: {
      requestId: context.get("requestId"),
      runGeneration: params.data.generation,
      runId: params.data.runId,
    },
    stub: context.env.GAME_CONTAINER.get(id),
  };
}

async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentLength = contentLengthSchema.safeParse(
    request.headers.get("content-length"),
  );
  if (!contentLength.success || contentLength.data > MAX_BODY_BYTES) {
    throw new PublisherRequestError(
      413,
      "body_too_large",
      "The publisher request body is too large.",
    );
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new PublisherRequestError(
      413,
      "body_too_large",
      "The publisher request body is too large.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new PublisherRequestError(
      400,
      "json_invalid",
      "Publisher signaling requires a valid JSON body.",
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PublisherRequestError(
      400,
      "body_invalid",
      "The publisher request body does not match this operation.",
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
    return publisherError(
      result.error.status,
      result.error.code,
      result.error.message,
      requestId,
      result.error.retryable,
    );
  }
  return publisherJson(result.value, status, requestId);
}

function publisherError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable = false,
): Response {
  return publisherJson(
    {
      code,
      error: message,
      requestId,
      retryable,
    },
    status,
    requestId,
  );
}

function publisherJson(
  body: unknown,
  status: number,
  requestId: string,
): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
    status,
  });
}

class PublisherRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
