import { DurableObject } from "cloudflare:workers";
import { SfuClient, buildWsCallbackUrl, extractJpegFromSfuPacket } from "./shared/sfu-utils";

interface SessionState {
  id: string;
  type: "sfu-video" | "viewer";
  createdAt?: number;
}

interface VideoAdapterState {
  sfuSessionId?: string;
  videoTrackName?: string;
  sfuAdapterId?: string;
  sessionName?: string;
}

/**
 * VideoAdapter Durable Object
 *
 * Per-session controller that:
 *  - Creates an SFU session for a WebRTC publisher (camera)
 *  - Stores the published video track name
 *  - Sets up a WebSocket adapter (remote/stream) with outputCodec "jpeg"
 *  - Receives JPEG frames from the SFU and broadcasts them to viewer WebSockets
 */
export class VideoAdapter extends DurableObject<Env> {
  env: Env;
  private state: VideoAdapterState;
  private lastFrame: Uint8Array | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    this.state = {};

    // Restore persisted state
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<VideoAdapterState>("state");
      if (stored) {
        this.state = stored;
      }
    });
  }

  private log(...args: any[]) {
    console.log("[VideoAdapter]", this.ctx.id.toString(), "-", ...args);
  }

  private async saveState() {
    await this.ctx.storage.put("state", this.state);
  }

  /**
   * Handle HTTP + WebSocket requests routed to this Durable Object instance.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname
      .substring(1)
      .split("/")
      .filter((p) => p);

    if (pathParts.length < 2) {
      return new Response("Invalid request to VideoAdapter", { status: 400 });
    }

    const sessionName = pathParts[0];
    const section = pathParts[1]; // expected "video"
    const action = pathParts.length > 2 ? pathParts[2] : null;

    if (section !== "video") {
      return new Response("Not Found in VideoAdapter", { status: 404 });
    }

    // Persist human-readable session name once
    if (!this.state.sessionName) {
      this.state.sessionName = sessionName;
      await this.saveState();
    }

    // WebSocket endpoints
    if (request.headers.get("Upgrade") === "websocket") {
      switch (action) {
        case "sfu-subscribe":
          return this.handleSfuSubscribe(request);
        case "viewer":
          return this.handleViewerSubscribe(request);
        default:
          return new Response("Unknown WebSocket endpoint", { status: 404 });
      }
    }

    // HTTP endpoints
    switch (action) {
      case "connect":
        return this.handleConnect(request, sessionName);
      case "start-forwarding":
        return this.handleStartForwarding(request, sessionName);
      case "stop-forwarding":
        return this.handleStopForwarding();
      default:
        return new Response(
          'VideoAdapter: Use POST /<session>/video/connect, /start-forwarding, /stop-forwarding, or WebSocket /video/viewer.',
          { status: 200 }
        );
    }
  }

  /**
   * WebSocket message handler for both SFU and viewer sockets.
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    const session = ws.deserializeAttachment() as SessionState | null;
    if (!session) return;

    if (session.type === "sfu-video" && message instanceof ArrayBuffer) {
      this.handleSfuVideoPacket(message);
    } else if (session.type === "viewer" && typeof message === "string") {
      // Optional: handle simple control messages from viewers later
      this.log("Viewer control message", session.id, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const session = ws.deserializeAttachment() as SessionState | null;
    if (session) {
      this.log(`WebSocket closed (${session.type} ${session.id}):`, code, reason, "clean=", wasClean);
    } else {
      this.log("WebSocket closed (unknown session)", code, reason);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const session = ws.deserializeAttachment() as SessionState | null;
    if (session) {
      this.log(`WebSocket error (${session.type} ${session.id}):`, error);
    } else {
      this.log("WebSocket error (unknown session):", error);
    }
  }

  // --- HTTP handlers ---

  /**
   * Handles POST /<session>/video/connect
   *
   * Uses autoDiscover to publish the browser's WebRTC offer into a new SFU session
   * and stores the resulting video track name for later forwarding.
   */
  private async handleConnect(request: Request, sessionName: string): Promise<Response> {
    try {
      const { sessionDescription } = (await request.json()) as any;
      if (!sessionDescription) return new Response("Missing sessionDescription", { status: 400 });

      const sfu = new SfuClient(this.env);
      const { sessionId: sfuSessionId } = await sfu.createSession();
      const { json: publishResponse, videoTrackName } = await sfu.addTracksAutoDiscoverForVideo(
        sfuSessionId,
        sessionDescription
      );

      if (!videoTrackName) {
        throw new Error("Failed to get video track name from SFU response");
      }

      this.log(
        `Connected publisher for session "${sessionName}" to SFU session ${sfuSessionId} with video track ${videoTrackName}`
      );

      this.state.sfuSessionId = sfuSessionId;
      this.state.videoTrackName = videoTrackName;
      await this.saveState();

      return new Response(JSON.stringify(publishResponse), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error: any) {
      this.log("Video connect error:", error?.message || error);
      return new Response(`Video connect error: ${error?.message || error}`, { status: 500 });
    }
  }

  /**
   * Handles POST /<session>/video/start-forwarding
   *
   * Creates a WebSocket adapter in remote/stream mode so that the SFU sends JPEG
   * frames for the published video track to this Durable Object.
   */
  private async handleStartForwarding(request: Request, sessionName: string): Promise<Response> {
    const sfuSessionId = this.state.sfuSessionId;
    const videoTrackName = this.state.videoTrackName;

    if (!sfuSessionId || !videoTrackName) {
      return new Response("Missing SFU session or video track. Call /video/connect first.", { status: 400 });
    }

    // Idempotent: if adapter is already active, no-op
    if (this.state.sfuAdapterId) {
      this.log("Forwarding already active via adapter", this.state.sfuAdapterId);
      return new Response("Forwarding already active", { status: 200 });
    }

    try {
      const callbackUrl = buildWsCallbackUrl(request, `/${sessionName}/video/sfu-subscribe`);
      this.log("Starting JPEG forwarding for", videoTrackName, "via", callbackUrl);

      const sfu = new SfuClient(this.env);
      const { adapterId } = await sfu.pullTrackToWebSocket(sfuSessionId, videoTrackName, callbackUrl, {
        outputCodec: "jpeg",
      });

      if (adapterId) {
        this.state.sfuAdapterId = adapterId;
        await this.saveState();
        this.log("Stored video adapterId:", adapterId);
      }

      return new Response("WebSocket forwarding started successfully", { status: 200 });
    } catch (error: any) {
      this.log("Error starting video forwarding:", error?.message || error);
      return new Response(`Error starting forwarding: ${error?.message || error}`, { status: 500 });
    }
  }

  /**
   * Handles POST /<session>/video/stop-forwarding
   */
  private async handleStopForwarding(): Promise<Response> {
    const adapterId = this.state.sfuAdapterId;
    if (!adapterId) {
      this.log("Stop-forwarding requested but no adapterId found. No-op.");
      return new Response("Forwarding already stopped", { status: 200 });
    }

    this.log("Closing video forwarding adapter", adapterId);
    const sfu = new SfuClient(this.env);
    const close = await sfu.closeWebSocketAdapter(adapterId);
    if (!close.ok) {
      this.log("Failed to stop video forwarding:", close.status, close.text);
      return new Response(`Failed to stop forwarding: ${close.text}`, { status: 500 });
    }
    if (close.alreadyClosed) {
      this.log("Adapter already closed on SFU. Proceeding with local cleanup.");
    }

    delete this.state.sfuAdapterId;
    await this.saveState();

    this.log("Video forwarding stopped.");
    return new Response("Forwarding stopped", { status: 200 });
  }

  // --- WebSocket helpers ---

  /**
   * Handles WebSocket upgrade from SFU for video JPEG stream.
   * Endpoint: WS /<session>/video/sfu-subscribe
   */
  private handleSfuSubscribe(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const sessionState: SessionState = {
      id: crypto.randomUUID(),
      type: "sfu-video",
      createdAt: Date.now(),
    };
    server.serializeAttachment(sessionState);

    // Enforce a single SFU video stream: close any existing sfu-video sockets
    const existingSockets = this.ctx.getWebSockets();
    for (const ws of existingSockets) {
      if (ws !== server && ws.readyState === WebSocket.OPEN) {
        const attachment = ws.deserializeAttachment() as SessionState | null;
        if (attachment && attachment.type === "sfu-video") {
          this.log("Closing existing SFU video socket", attachment.id, "to enforce single subscriber");
          ws.close(1000, "Superseded by newer subscriber");
        }
      }
    }

    this.log("New SFU video WebSocket established:", sessionState.id);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handles WebSocket upgrade from viewers.
   * Endpoint: WS /<session>/video/viewer
   */
  private handleViewerSubscribe(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const sessionState: SessionState = {
      id: crypto.randomUUID(),
      type: "viewer",
      createdAt: Date.now(),
    };

    server.serializeAttachment(sessionState);

    this.log("New viewer WebSocket connection:", sessionState.id);

    // If we have a last frame, send it immediately to the new viewer
    if (this.lastFrame && this.lastFrame.byteLength > 0 && server.readyState === WebSocket.OPEN) {
      server.send(this.lastFrame);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Process an incoming SFU Packet containing a JPEG frame.
   */
  private handleSfuVideoPacket(packetData: ArrayBuffer) {
    const jpeg = extractJpegFromSfuPacket(packetData);
    if (!jpeg || jpeg.byteLength === 0) {
      return;
    }

    // Store a copy for late joiners
    this.lastFrame = new Uint8Array(jpeg);

    // Broadcast to viewer clients
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      return;
    }

    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as SessionState | null;
      if (!attachment || attachment.type !== "viewer") continue;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(this.lastFrame);
      }
    }
  }

  /**
   * Hard-destroy this session: close all clients and wipe stored state.
   * Called from the Worker root via DELETE /<session>.
   */
  public async destroy(): Promise<void> {
    this.log("Destroy requested: closing clients and deleting state");

    try {
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.close(1000, "Session destroyed");
        } catch {
          // ignore
        }
      }

      this.lastFrame = null;
      this.state = {};
      await this.ctx.storage.deleteAll();
    } catch (error) {
      this.log("Error during destroy():", error);
    }
  }
}
