import type { GameSnapshot, ViewerJoinResponse } from "../shared/protocol";
import {
  CloudGamingApi,
  type ViewerCredentials,
} from "./api";
import {
  setupViewerDataChannels,
  type ViewerControlEndpoint,
} from "./viewer-datachannels";
import { createGatheredOffer } from "./webrtc";

const DISCONNECTED_GRACE_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_AUTOMATIC_RECONNECT_ATTEMPTS = 3;
const MAX_RECONNECT_DELAY_MS = 8_000;

export type ViewerPhase =
  | "connecting"
  | "connected"
  | "error"
  | "idle"
  | "reconnecting";

type ViewerCallbacks = {
  onError: (context: string, error: unknown) => void;
  onMediaChange: (hasVideo: boolean) => void;
  onPhaseChange: (phase: ViewerPhase, message: string) => void;
  onSessionWillClose: () => Promise<void>;
};

type ViewerSession = {
  closing: boolean;
  credentials: ViewerCredentials;
  disconnectTimer?: number;
  heartbeatInFlight: boolean;
  heartbeatTimer: number;
  keyboard: RTCDataChannel;
  mediaStream: MediaStream;
  peer: RTCPeerConnection;
  pointer: RTCDataChannel;
  runGeneration: number;
};

class StaleViewerAttempt extends Error {}

export class ViewerManager {
  private current: ViewerSession | null = null;
  private automaticRetryExhausted = false;
  private desiredSnapshot: GameSnapshot | null = null;
  private disposed = false;
  private forceFresh = false;
  private lastFailure: string | null = null;
  private nextAttemptAt = 0;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileRequested = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly api: CloudGamingApi,
    private readonly video: HTMLVideoElement,
    private readonly callbacks: ViewerCallbacks,
  ) {}

  get credentials(): ViewerCredentials | null {
    return this.current?.credentials ?? null;
  }

  get controlEndpoint(): ViewerControlEndpoint | null {
    const session = this.current;
    if (!session || session.closing) return null;
    return {
      credentials: session.credentials,
      keyboard: session.keyboard,
      pointer: session.pointer,
    };
  }

  sync(snapshot: GameSnapshot): void {
    this.desiredSnapshot = snapshot;
    this.queueReconcile();
  }

  retry(): void {
    this.automaticRetryExhausted = false;
    this.forceFresh = true;
    this.lastFailure = "Retrying with a fresh viewer session.";
    this.nextAttemptAt = 0;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.queueReconcile();
  }

  shutdownKeepalive(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    const session = this.current;
    this.current = null;
    if (!session) return;

    session.closing = true;
    window.clearInterval(session.heartbeatTimer);
    if (session.disconnectTimer !== undefined) {
      window.clearTimeout(session.disconnectTimer);
    }
    void this.api.leaveViewer(session.credentials, true).catch(() => {});
    session.keyboard.close();
    session.pointer.close();
    session.peer.close();
    for (const track of session.mediaStream.getTracks()) track.stop();
    if (this.video.srcObject === session.mediaStream) {
      this.video.srcObject = null;
    }
  }

  private queueReconcile(): void {
    if (this.disposed) return;
    this.reconcileRequested = true;
    if (this.reconcilePromise) return;

    this.reconcilePromise = this.runReconcileLoop()
      .catch((error) => {
        this.callbacks.onError("Viewer lifecycle", error);
      })
      .finally(() => {
        this.reconcilePromise = null;
        if (this.reconcileRequested) this.queueReconcile();
      });
  }

  private async runReconcileLoop(): Promise<void> {
    while (this.reconcileRequested && !this.disposed) {
      this.reconcileRequested = false;
      await this.reconcile();
    }
  }

  private async reconcile(): Promise<void> {
    const snapshot = this.desiredSnapshot;
    if (!snapshot || !isViewable(snapshot)) {
      this.forceFresh = false;
      this.automaticRetryExhausted = false;
      this.lastFailure = null;
      this.nextAttemptAt = 0;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      await this.closeCurrent(true);
      this.callbacks.onPhaseChange("idle", idleMessage(snapshot));
      return;
    }

    const currentIsUsable =
      this.current !== null &&
      this.current.runGeneration === snapshot.runGeneration &&
      this.current.peer.connectionState !== "closed" &&
      this.current.peer.connectionState !== "failed";
    if (currentIsUsable && !this.forceFresh) return;
    if (this.automaticRetryExhausted && !this.forceFresh) return;

    if (Date.now() < this.nextAttemptAt) {
      this.scheduleReconnect(this.nextAttemptAt - Date.now());
      return;
    }

    const reconnecting =
      this.current !== null ||
      this.lastFailure !== null ||
      this.reconnectAttempts > 0;
    await this.closeCurrent(true);
    if (this.disposed) return;

    this.forceFresh = false;
    this.callbacks.onMediaChange(false);
    this.callbacks.onPhaseChange(
      reconnecting ? "reconnecting" : "connecting",
      reconnecting
        ? this.lastFailure ?? "Opening a fresh viewer session."
        : "Opening a receive-only media session.",
    );

    try {
      await this.connect(snapshot);
      this.lastFailure = null;
      this.nextAttemptAt = 0;
      this.reconnectAttempts = 0;
      this.automaticRetryExhausted = false;
      this.clearReconnectTimer();
    } catch (error) {
      if (error instanceof StaleViewerAttempt || this.disposed) return;

      this.reconnectAttempts += 1;
      if (this.reconnectAttempts >= MAX_AUTOMATIC_RECONNECT_ATTEMPTS) {
        this.automaticRetryExhausted = true;
        this.lastFailure =
          "The viewer could not reconnect automatically. Select Retry.";
        this.nextAttemptAt = 0;
        this.callbacks.onPhaseChange("error", this.lastFailure);
        this.callbacks.onError("Viewer connection", error);
        this.clearReconnectTimer();
        return;
      }
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        1_000 * 2 ** Math.min(this.reconnectAttempts - 1, 3),
      );
      this.lastFailure = "The signal failed. Creating a fresh viewer session.";
      this.nextAttemptAt = Date.now() + delay;
      this.callbacks.onPhaseChange("error", this.lastFailure);
      this.callbacks.onError("Viewer connection", error);
      this.scheduleReconnect(delay);
    }
  }

  private async connect(snapshot: GameSnapshot): Promise<void> {
    if (typeof RTCPeerConnection !== "function") {
      throw new Error("This browser does not support WebRTC.");
    }

    const peer = new RTCPeerConnection({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    const mediaStream = new MediaStream();
    let joined: ViewerJoinResponse | null = null;
    let session: ViewerSession | null = null;

    peer.addEventListener("track", (event) => {
      if (!mediaStream.getTracks().some((track) => track.id === event.track.id)) {
        mediaStream.addTrack(event.track);
      }
      if (session && this.current === session) {
        this.video.srcObject = mediaStream;
        this.callbacks.onMediaChange(mediaStream.getVideoTracks().length > 0);
        void this.video.play().catch(() => {});
      }
      event.track.addEventListener(
        "ended",
        () => {
          if (session && this.current === session && !session.closing) {
            this.requestReconnect(session, "The incoming media track ended.", 750);
          }
        },
        { once: true },
      );
    });

    peer.addEventListener("connectionstatechange", () => {
      if (session && this.current === session) {
        this.handleConnectionState(session);
      }
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      if (
        session &&
        this.current === session &&
        peer.iceConnectionState === "failed"
      ) {
        this.requestReconnect(session, "The media ICE transport failed.", 750);
      }
    });
    try {
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.addTransceiver("audio", { direction: "recvonly" });
      const offer = await createGatheredOffer(peer);
      joined = await this.api.joinViewer(offer);
      await peer.setRemoteDescription(joined.sessionDescription);
      const credentials = {
        viewerCapability: joined.viewerCapability,
        viewerId: joined.viewerId,
      };

      const inputChannels = await setupViewerDataChannels(
        this.api,
        peer,
        credentials,
      );

      if (
        !this.isDesiredRun(snapshot.runGeneration) ||
        joined.runGeneration !== snapshot.runGeneration
      ) {
        throw new StaleViewerAttempt();
      }

      session = {
        closing: false,
        credentials,
        heartbeatInFlight: false,
        heartbeatTimer: 0,
        keyboard: inputChannels.keyboard,
        mediaStream,
        peer,
        pointer: inputChannels.pointer,
        runGeneration: joined.runGeneration,
      };
      attachInputChannelEvents(session, () => {
        if (session && this.current === session && !session.closing) {
          this.requestReconnect(
            session,
            "The viewer DataChannel transport closed.",
            750,
          );
        }
      });
      session.heartbeatTimer = window.setInterval(() => {
        if (session) void this.heartbeat(session);
      }, HEARTBEAT_INTERVAL_MS);
      this.current = session;
      this.video.srcObject = mediaStream;
      this.callbacks.onMediaChange(mediaStream.getVideoTracks().length > 0);
      this.handleConnectionState(session);
      void this.video.play().catch(() => {});
    } catch (error) {
      peer.close();
      for (const track of mediaStream.getTracks()) track.stop();
      if (joined) {
        await this.api
          .leaveViewer(
            {
              viewerCapability: joined.viewerCapability,
              viewerId: joined.viewerId,
            },
            this.disposed,
          )
          .catch(() => {});
      }
      throw error;
    }
  }

  private handleConnectionState(session: ViewerSession): void {
    if (session.closing || this.current !== session) return;

    switch (session.peer.connectionState) {
      case "connected":
        if (session.disconnectTimer !== undefined) {
          window.clearTimeout(session.disconnectTimer);
          session.disconnectTimer = undefined;
        }
        this.callbacks.onPhaseChange(
          "connected",
          "Live media is arriving through a receive-only viewer session.",
        );
        break;
      case "disconnected":
        if (session.disconnectTimer === undefined) {
          this.callbacks.onPhaseChange(
            "reconnecting",
            "The media transport is interrupted. Waiting briefly for recovery.",
          );
          session.disconnectTimer = window.setTimeout(() => {
            session.disconnectTimer = undefined;
            this.requestReconnect(
              session,
              "The media transport did not recover.",
              0,
            );
          }, DISCONNECTED_GRACE_MS);
        }
        break;
      case "failed":
      case "closed":
        this.requestReconnect(session, "The media transport failed.", 750);
        break;
      default:
        this.callbacks.onPhaseChange(
          this.reconnectAttempts > 0 ? "reconnecting" : "connecting",
          "Negotiating the media transport.",
        );
    }
  }

  private requestReconnect(
    session: ViewerSession,
    message: string,
    delay: number,
  ): void {
    if (session.closing || this.current !== session || this.disposed) return;
    this.forceFresh = true;
    this.lastFailure = message;
    this.nextAttemptAt = Date.now() + delay;
    this.callbacks.onPhaseChange(
      "reconnecting",
      `${message} Opening a fresh viewer session.`,
    );
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.queueReconcile();
    }, Math.max(0, delay));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async heartbeat(session: ViewerSession): Promise<void> {
    if (
      session.closing ||
      session.heartbeatInFlight ||
      this.current !== session
    ) {
      return;
    }

    session.heartbeatInFlight = true;
    try {
      await this.api.heartbeatViewer(session.credentials);
    } catch (error) {
      if (this.current === session && !session.closing) {
        this.callbacks.onError("Viewer heartbeat", error);
        this.requestReconnect(
          session,
          "The viewer heartbeat failed.",
          1_000,
        );
      }
    } finally {
      session.heartbeatInFlight = false;
    }
  }

  private async closeCurrent(leave: boolean): Promise<void> {
    const session = this.current;
    if (!session) {
      if (this.video.srcObject !== null) this.video.srcObject = null;
      return;
    }

    this.current = null;
    session.closing = true;
    window.clearInterval(session.heartbeatTimer);
    if (session.disconnectTimer !== undefined) {
      window.clearTimeout(session.disconnectTimer);
    }

    try {
      await this.callbacks.onSessionWillClose();
    } catch (error) {
      this.callbacks.onError("Control cleanup", error);
    }

    session.peer.close();
    session.keyboard.close();
    session.pointer.close();
    for (const track of session.mediaStream.getTracks()) track.stop();
    if (this.video.srcObject === session.mediaStream) {
      this.video.srcObject = null;
    }
    this.callbacks.onMediaChange(false);

    if (leave) {
      await this.api
        .leaveViewer(session.credentials, this.disposed)
        .catch(() => {});
    }
  }

  private isDesiredRun(runGeneration: number): boolean {
    return (
      !this.disposed &&
      this.desiredSnapshot !== null &&
      isViewable(this.desiredSnapshot) &&
      this.desiredSnapshot.runGeneration === runGeneration
    );
  }
}

function attachInputChannelEvents(
  session: ViewerSession,
  onUnavailable: () => void,
): void {
  for (const channel of [session.keyboard, session.pointer]) {
    channel.addEventListener("close", onUnavailable);
    channel.addEventListener("error", onUnavailable);
  }
}

function isViewable(snapshot: GameSnapshot): boolean {
  return snapshot.status === "running";
}

function idleMessage(snapshot: GameSnapshot | null): string {
  switch (snapshot?.status) {
    case "starting":
      return "The game container is starting.";
    case "stopping":
      return "The game is stopping and viewer resources are closing.";
    case "failed":
      return "The game run failed. Start a new run after cleanup.";
    default:
      return "The viewer is waiting for a running game.";
  }
}
