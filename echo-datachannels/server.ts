import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ChannelProfileId,
  type DataChannelLocation,
} from "./channel-config.ts";
import {
  loadRealtimeSfuCredentials,
  LocalConfigurationError,
  type RealtimeSfuCredentials,
} from "./local-config.ts";
import {
  SessionMutationCoordinator,
  SessionMutationError,
} from "./session-mutations.ts";
import {
  SfuApiClient,
  SfuApiError,
  type SessionDescription,
  type SfuApiOperations,
} from "./sfu-api.ts";

const ROOT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const JSON_CONTENT_TYPE = "application/json";
const MAX_REQUEST_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const STATIC_FILES = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["dist/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

type JsonRecord = Record<string, unknown>;

interface Logger {
  error(message: string, details?: unknown): void;
}

interface ServerOptions {
  sfuClient: SfuApiOperations;
  mutationCoordinator?: SessionMutationCoordinator;
  rootDirectory?: string;
  logger?: Logger;
}

interface StartServerOptions extends ServerOptions {
  host?: string;
  port?: number;
}

interface RunningServer {
  server: ReturnType<typeof createServer>;
  origin: string;
  close(): Promise<void>;
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  sfuClient: SfuApiOperations;
  mutationCoordinator: SessionMutationCoordinator;
  rootDirectory: string;
}

class InputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "InputError";
    this.code = code;
    this.status = status;
  }
}

export function createRequestHandler({
  sfuClient,
  mutationCoordinator = new SessionMutationCoordinator(),
  rootDirectory = ROOT_DIRECTORY,
  logger = console,
}: ServerOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => void {
  if (!sfuClient) {
    throw new TypeError("sfuClient is required");
  }

  return (request, response) => {
    void handleRequest({
      request,
      response,
      sfuClient,
      mutationCoordinator,
      rootDirectory,
    }).catch((error: unknown) => {
      writeError(response, error, logger);
    });
  };
}

export async function startExampleServer({
  sfuClient,
  mutationCoordinator = new SessionMutationCoordinator(),
  host = "127.0.0.1",
  port = 8787,
  rootDirectory = ROOT_DIRECTORY,
  logger = console,
}: StartServerOptions): Promise<RunningServer> {
  const server = createServer(
    createRequestHandler({
      sfuClient,
      mutationCoordinator,
      rootDirectory,
      logger,
    }),
  );

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The example server did not expose a TCP address");
  }

  return {
    server,
    origin: `http://${host}:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
          } else {
            resolvePromise();
          }
        });
      });
    },
  };
}

async function handleRequest({
  request,
  response,
  sfuClient,
  mutationCoordinator,
  rootDirectory,
}: RequestContext): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApiRequest(
      request,
      response,
      url.pathname,
      sfuClient,
      mutationCoordinator,
    );
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new InputError("method_not_allowed", "Method not allowed", 405);
  }

  const staticFile = STATIC_FILES.get(url.pathname);
  if (!staticFile) {
    throw new InputError("not_found", "File not found", 404);
  }

  const [relativePath, contentType] = staticFile;
  const body = await readFile(resolve(rootDirectory, relativePath));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  sfuClient: SfuApiOperations,
  mutationCoordinator: SessionMutationCoordinator,
): Promise<void> {
  if (pathname === "/api/sessions" && request.method === "POST") {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, []);
    const session = await sfuClient.createSession();
    mutationCoordinator.registerSession(session.sessionId);
    writeJson(response, 201, session);
    return;
  }

  const match = pathname.match(
    /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/(datachannel-transport|renegotiate|datachannels|datachannels\/close)$/,
  );
  if (!match) {
    throw new InputError("not_found", "API route not found", 404);
  }

  const sessionId = requireSessionId(match[1], "sessionId");
  const action = match[2];
  if (action === "datachannel-transport" && request.method === "POST") {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, []);
    writeJson(
      response,
      200,
      await mutationCoordinator.mutate(sessionId, () =>
        sfuClient.establishDataChannelTransport(sessionId),
      ),
    );
    return;
  }

  if (action === "renegotiate" && request.method === "PUT") {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ["sessionDescription"]);
    writeJson(
      response,
      200,
      await mutationCoordinator.renegotiate(sessionId, () =>
        sfuClient.renegotiate(
          sessionId,
          requireSessionDescription(body.sessionDescription),
        ),
      ),
    );
    return;
  }

  if (action === "datachannels" && request.method === "POST") {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ["profile", "location", "publisherSessionId"]);
    const profileId = requireProfile(body.profile);
    const location = requireLocation(body.location);
    const publisherSessionId =
      location === "remote"
        ? requireSessionId(body.publisherSessionId, "publisherSessionId")
        : undefined;
    if (location === "local" && body.publisherSessionId !== undefined) {
      throw new InputError(
        "invalid_request",
        "publisherSessionId is allowed only for remote DataChannels",
      );
    }

    writeJson(
      response,
      201,
      await mutationCoordinator.mutate(sessionId, () =>
        sfuClient.createDataChannel({
          sessionId,
          profileId,
          location,
          ...(publisherSessionId === undefined
            ? {}
            : { publisherSessionId }),
        }),
      ),
    );
    return;
  }

  if (action === "datachannels/close" && request.method === "PUT") {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ["channelIds"]);
    writeJson(
      response,
      200,
      await mutationCoordinator.mutate(sessionId, () =>
        sfuClient.closeDataChannels(
          sessionId,
          requireChannelIds(body.channelIds),
        ),
      ),
    );
    return;
  }

  throw new InputError("method_not_allowed", "Method not allowed", 405);
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<JsonRecord> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith(JSON_CONTENT_TYPE)) {
    throw new InputError(
      "content_type_required",
      "Send the request with Content-Type: application/json",
      415,
    );
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > MAX_REQUEST_BYTES) {
      throw new InputError(
        "request_too_large",
        "JSON request body exceeds 256 KiB",
        413,
      );
    }
    chunks.push(buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("invalid_json", "Request body is not valid JSON");
  }
  return requireRecord(body, "request body");
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("invalid_request", `${field} must be a JSON object`);
  }
  return value as JsonRecord;
}

function assertOnlyKeys(
  value: JsonRecord,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  const firstUnknownKey = unknownKeys[0];
  if (firstUnknownKey !== undefined) {
    throw new InputError(
      "invalid_request",
      `Unexpected request field: ${firstUnknownKey}`,
    );
  }
}

function requireSessionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new InputError(
      "invalid_session_id",
      `${field} must be 1-128 letters, numbers, underscores, or hyphens`,
    );
  }
  return value;
}

function requireProfile(value: unknown): ChannelProfileId {
  if (typeof value !== "string") {
    throw new InputError(
      "invalid_profile",
      "profile must name one of the displayed channel configurations",
    );
  }
  if (
    value !== "reliable-ordered" &&
    value !== "unreliable-unordered"
  ) {
    throw new InputError(
      "invalid_profile",
      `Unsupported DataChannel profile: ${value}`,
    );
  }
  return value;
}

function requireLocation(value: unknown): DataChannelLocation {
  if (value !== "local" && value !== "remote") {
    throw new InputError(
      "invalid_location",
      'location must be either "local" or "remote"',
    );
  }
  return value;
}

function requireSessionDescription(
  value: unknown,
): SessionDescription<"answer"> {
  const description = requireRecord(value, "sessionDescription");
  assertOnlyKeys(description, ["type", "sdp"]);
  if (description.type !== "answer") {
    throw new InputError(
      "invalid_session_description",
      'sessionDescription.type must be "answer"',
    );
  }
  if (
    typeof description.sdp !== "string" ||
    description.sdp.length === 0 ||
    description.sdp.length > MAX_REQUEST_BYTES
  ) {
    throw new InputError(
      "invalid_session_description",
      "sessionDescription.sdp must be a non-empty string no larger than 256 KiB",
    );
  }
  return {
    type: description.type,
    sdp: description.sdp,
  };
}

function requireChannelIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new InputError(
      "invalid_channel_ids",
      "channelIds must contain 1-8 application DataChannel IDs",
    );
  }
  const ids = [...new Set(value)];
  if (
    ids.some(
      (id) =>
        typeof id !== "number" ||
        !Number.isInteger(id) ||
        id < 1 ||
        id > 65_534,
    )
  ) {
    throw new InputError(
      "invalid_channel_ids",
      "Every channelIds value must be an integer from 1 through 65534",
    );
  }
  return ids as number[];
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": `${JSON_CONTENT_TYPE}; charset=utf-8`,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function writeError(
  response: ServerResponse,
  error: unknown,
  logger: Logger,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  if (
    error instanceof InputError ||
    error instanceof SfuApiError ||
    error instanceof SessionMutationError
  ) {
    writeJson(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  logger.error("DataChannel example request failed", {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  writeJson(response, 500, {
    error: {
      code: "internal_error",
      message:
        "The local example server failed. Check its terminal output and retry.",
    },
  });
}

async function startFromEnvironment(): Promise<void> {
  let credentials: RealtimeSfuCredentials;
  try {
    credentials = await loadRealtimeSfuCredentials();
  } catch (error) {
    if (error instanceof LocalConfigurationError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { appId, token } = credentials;
  const host = process.env.HOST ?? "127.0.0.1";
  const port = parsePort(process.env.PORT ?? "8787");
  const sfuClient = new SfuApiClient({
    appId,
    token,
    apiBase:
      process.env.REALTIME_SFU_API_BASE ??
      "https://rtc.live.cloudflare.com/v1",
  });
  const runningServer = await startExampleServer({
    sfuClient,
    host,
    port,
  });
  console.log(`DataChannel example listening at ${runningServer.origin}`);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await runningServer.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("PORT must be an integer from 0 through 65535");
  }
  return port;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  await startFromEnvironment();
}
