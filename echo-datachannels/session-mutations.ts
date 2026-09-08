export class SessionMutationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "SessionMutationError";
    this.code = code;
    this.status = status;
  }
}

const UNSTABLE_NEGOTIATION_CODES = new Set([
  "signaling_state_not_stable",
  "invalid_modification_have_local_offer",
  "invalid_modification_have_remote_offer",
  "invalid_modification_have_local_pranswer",
  "invalid_modification_have_remote_pranswer",
]);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface PendingRenegotiation {
  answerInFlight: Promise<unknown> | null;
  stable: Deferred;
}

interface SessionMutationState {
  tail: Promise<void>;
  pendingRenegotiation: PendingRenegotiation | null;
}

interface SessionMutationCoordinatorOptions {
  isUnstableSignalingError?: (error: unknown) => boolean;
  maxUnstableRetries?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class SessionMutationCoordinator {
  private readonly sessions = new Map<string, SessionMutationState>();
  private readonly isUnstableSignalingError: (error: unknown) => boolean;
  private readonly maxUnstableRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor({
    isUnstableSignalingError = defaultIsUnstableSignalingError,
    maxUnstableRetries = 3,
    retryDelayMs = 50,
    sleep = (delayMs) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  }: SessionMutationCoordinatorOptions = {}) {
    this.isUnstableSignalingError = isUnstableSignalingError;
    this.maxUnstableRetries = maxUnstableRetries;
    this.retryDelayMs = retryDelayMs;
    this.sleep = sleep;
  }

  registerSession(sessionId: string): void {
    this.getSession(sessionId);
  }

  mutate<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const session = this.getSession(sessionId);
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const resultPromise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise;
      rejectResult = rejectPromise;
    });

    session.tail = session.tail.then(async () => {
      try {
        const result = await this.runWithStableRetry(operation);
        if (requiresImmediateRenegotiation(result)) {
          const stable = createDeferred();
          session.pendingRenegotiation = {
            answerInFlight: null,
            stable,
          };
          resolveResult(result);
          await stable.promise;
          return;
        }
        resolveResult(result);
      } catch (error) {
        rejectResult(error);
      }
    });

    return resultPromise;
  }

  async renegotiate<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const session = this.getSession(sessionId);
    const pending = session.pendingRenegotiation;
    if (!pending) {
      throw new SessionMutationError(
        "renegotiation_not_pending",
        "This session does not have an offer waiting for a renegotiation answer.",
      );
    }
    if (pending.answerInFlight) {
      return pending.answerInFlight as Promise<T>;
    }

    const answer = this.runWithStableRetry(operation).then((result) => {
      if (session.pendingRenegotiation === pending) {
        session.pendingRenegotiation = null;
        pending.stable.resolve();
      }
      return result;
    });
    pending.answerInFlight = answer;

    try {
      return await answer;
    } finally {
      if (session.pendingRenegotiation === pending) {
        pending.answerInFlight = null;
      }
    }
  }

  hasPendingRenegotiation(sessionId: string): boolean {
    return this.getSession(sessionId).pendingRenegotiation !== null;
  }

  private getSession(sessionId: string): SessionMutationState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        tail: Promise.resolve(),
        pendingRenegotiation: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private async runWithStableRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let unstableRetries = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (
          !this.isUnstableSignalingError(error) ||
          unstableRetries >= this.maxUnstableRetries
        ) {
          throw error;
        }
        unstableRetries += 1;
        await this.sleep(this.retryDelayMs * unstableRetries);
      }
    }
  }
}

function defaultIsUnstableSignalingError(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const status = errorRecord?.upstreamStatus;
  const errorCode = String(
    errorRecord?.upstreamErrorCode ?? "",
  ).toLowerCase();
  const errorSubcode = String(
    errorRecord?.upstreamErrorSubcode ?? "",
  ).toLowerCase();

  if (status === 406) {
    if (
      errorCode === "invalid_session_description" &&
      errorSubcode.length === 0
    ) {
      return true;
    }
    return (
      UNSTABLE_NEGOTIATION_CODES.has(errorCode) ||
      (errorCode === "invalid_session_description" &&
        UNSTABLE_NEGOTIATION_CODES.has(errorSubcode))
    );
  }
  return (
    UNSTABLE_NEGOTIATION_CODES.has(errorCode) ||
    UNSTABLE_NEGOTIATION_CODES.has(errorSubcode)
  );
}

function requiresImmediateRenegotiation(value: unknown): boolean {
  return asRecord(value)?.requiresImmediateRenegotiation === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}
