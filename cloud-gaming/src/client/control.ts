import { CloudGamingApi, type ViewerCredentials } from "./api";
import { BrowserInput } from "./input";
import type { ViewerControlEndpoint } from "./viewer-datachannels";

const CONTROLLER_READY_TIMEOUT_MS = 20_000;

export type ControlPhase =
  | "claiming"
  | "error"
  | "idle"
  | "ready"
  | "releasing"
  | "waiting";

type ControlCallbacks = {
  onCaptureChange: (capturing: boolean) => void;
  onError: (context: string, error: unknown) => void;
  onPhaseChange: (phase: ControlPhase, message: string) => void;
};

type ControlSession = {
  closing: boolean;
  generation: number;
  input: BrowserInput | null;
  keyboard: RTCDataChannel;
  onChannelClose: () => void;
  onChannelError: () => void;
  onKeyboardMessage: (event: MessageEvent) => void;
  pointer: RTCDataChannel;
  publisherReady: boolean;
  readinessTimer: number | null;
  readyGeneration: number | null;
  viewer: ViewerCredentials;
};

class StaleControlAttempt extends Error {}

export class ControlManager {
  private claimAttempt = 0;
  private disposed = false;
  private session: ControlSession | null = null;

  constructor(
    private readonly api: CloudGamingApi,
    private readonly surface: HTMLElement,
    private readonly callbacks: ControlCallbacks,
  ) {}

  get hasSession(): boolean {
    return this.session !== null && !this.session.closing;
  }

  sendGameMenu(): void {
    if (!this.session?.input?.sendGameMenu()) {
      throw new Error("Control must be ready before opening the game menu.");
    }
  }

  async claim(endpoint: ViewerControlEndpoint): Promise<void> {
    if (this.session) return;
    if (this.disposed) throw new Error("The control manager is closed.");

    const attempt = ++this.claimAttempt;
    this.callbacks.onPhaseChange(
      "claiming",
      "Requesting the single controller assignment.",
    );

    const session = this.createSession(endpoint);
    this.session = session;
    this.attachChannelEvents(session);

    try {
      const response = await this.api.claimControl(endpoint.credentials);
      if (
        this.disposed ||
        attempt !== this.claimAttempt ||
        this.session !== session ||
        session.closing
      ) {
        throw new StaleControlAttempt();
      }

      session.generation = response.leaseGeneration;
      session.publisherReady =
        session.readyGeneration === response.leaseGeneration;
      session.readinessTimer = window.setTimeout(() => {
        void this.fail(
          session,
          new Error(
            "The publisher did not confirm controller readiness in time.",
          ),
        );
      }, CONTROLLER_READY_TIMEOUT_MS);
      this.callbacks.onPhaseChange(
        "waiting",
        "Control granted. Waiting for the publisher to adopt this generation.",
      );
      this.maybeEnableInput(session);
    } catch (error) {
      void this.api.releaseControl(endpoint.credentials, true).catch(() => {});
      this.teardownLocal(session);
      if (this.session === session) this.session = null;
      if (error instanceof StaleControlAttempt) return;
      this.callbacks.onPhaseChange(
        "error",
        "Control was not established. Take control must be requested again.",
      );
      throw error;
    }
  }

  async release(): Promise<void> {
    const session = this.session;
    if (!session) {
      this.callbacks.onPhaseChange("idle", "No controller assignment is held.");
      return;
    }
    if (session.closing) return;

    session.closing = true;
    this.callbacks.onPhaseChange(
      "releasing",
      "Resetting input and releasing control.",
    );
    this.teardownLocal(session);
    this.session = null;

    try {
      await this.api.releaseControl(session.viewer);
      this.callbacks.onPhaseChange(
        "idle",
        "Control released. It will not be restored automatically.",
      );
    } catch (error) {
      session.closing = false;
      this.session = session;
      this.callbacks.onPhaseChange(
        "error",
        "Local control ended, but remote release could not be confirmed.",
      );
      throw error;
    }
  }

  releaseForViewerChange(): void {
    const session = this.session;
    if (!session) return;
    this.claimAttempt += 1;
    this.teardownLocal(session);
    this.session = null;
    this.callbacks.onPhaseChange(
      "idle",
      "The viewer session changed, so control was released.",
    );
  }

  shutdownLocal(): void {
    this.disposed = true;
    this.claimAttempt += 1;
    const session = this.session;
    if (!session) return;
    this.teardownLocal(session);
    this.session = null;
  }

  private createSession(endpoint: ViewerControlEndpoint): ControlSession {
    const session = {} as ControlSession;
    session.closing = false;
    session.generation = 0;
    session.input = null;
    session.keyboard = endpoint.keyboard;
    session.onChannelClose = () => {
      if (this.session === session && !session.closing) {
        void this.fail(
          session,
          new Error("A viewer input channel closed."),
        );
      }
    };
    session.onChannelError = () => {
      if (this.session === session && !session.closing) {
        void this.fail(
          session,
          new Error("A viewer input channel reported an error."),
        );
      }
    };
    session.onKeyboardMessage = (event) => {
      if (this.session !== session || session.closing) return;
      const readyGeneration = controllerReadyGeneration(
        event.data,
        endpoint.credentials.viewerId,
      );
      if (readyGeneration === null) return;
      session.readyGeneration = readyGeneration;
      session.publisherReady = readyGeneration === session.generation;
      this.maybeEnableInput(session);
    };
    session.pointer = endpoint.pointer;
    session.publisherReady = false;
    session.readinessTimer = null;
    session.readyGeneration = null;
    session.viewer = endpoint.credentials;
    return session;
  }

  private attachChannelEvents(session: ControlSession): void {
    for (const channel of [session.keyboard, session.pointer]) {
      channel.addEventListener("close", session.onChannelClose);
      channel.addEventListener("error", session.onChannelError);
    }
    session.keyboard.addEventListener("message", session.onKeyboardMessage);
  }

  private maybeEnableInput(session: ControlSession): void {
    if (
      this.session !== session ||
      session.closing ||
      session.input !== null ||
      !session.publisherReady ||
      session.keyboard.readyState !== "open" ||
      session.pointer.readyState !== "open"
    ) {
      return;
    }

    if (session.readinessTimer !== null) {
      window.clearTimeout(session.readinessTimer);
      session.readinessTimer = null;
    }
    session.input = new BrowserInput({
      generation: session.generation,
      onCaptureChange: this.callbacks.onCaptureChange,
      onError: (error) => {
        if (this.session === session && !session.closing) {
          void this.fail(session, error);
        }
      },
      pointer: session.pointer,
      reliable: session.keyboard,
      surface: this.surface,
    });
    session.input.start();
    this.callbacks.onPhaseChange(
      "ready",
      "Control is ready. Click the game surface to capture the pointer.",
    );
  }

  private async fail(
    session: ControlSession,
    error: unknown,
  ): Promise<void> {
    if (this.session !== session || session.closing) return;
    session.closing = true;
    this.callbacks.onPhaseChange(
      "error",
      "Control disconnected. It will not be restored automatically.",
    );
    this.callbacks.onError("Controller", error);
    this.teardownLocal(session);
    this.session = null;
    await this.api.releaseControl(session.viewer).catch(() => {});
  }

  private teardownLocal(session: ControlSession): void {
    session.closing = true;
    if (session.readinessTimer !== null) {
      window.clearTimeout(session.readinessTimer);
      session.readinessTimer = null;
    }
    session.input?.dispose(true);
    session.input = null;
    this.callbacks.onCaptureChange(false);
    for (const channel of [session.keyboard, session.pointer]) {
      channel.removeEventListener("close", session.onChannelClose);
      channel.removeEventListener("error", session.onChannelError);
    }
    session.keyboard.removeEventListener("message", session.onKeyboardMessage);
  }
}

function controllerReadyGeneration(
  data: unknown,
  viewerId: string,
): number | null {
  if (typeof data !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const message = payload as Record<string, unknown>;
  return message.type === "controller-ready" &&
    message.viewerId === viewerId &&
    Number.isSafeInteger(message.generation)
    ? (message.generation as number)
    : null;
}
