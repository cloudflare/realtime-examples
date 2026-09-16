export class SessionQueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "SessionQueueError";
  }
}

export type MutationExecution<Response, Answer = never> = {
  response: Response;
  waitForAnswer?: (answer: Answer) => Promise<void>;
};

type QueueItem = {
  id: string;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<MutationExecution<unknown, unknown>>;
};

type BlockedMutation = {
  completing?: Promise<void>;
  id: string;
  timeout: ReturnType<typeof setTimeout>;
  waitForAnswer: (answer: unknown) => Promise<void>;
};

type MutationLedgerEntry = {
  answerCompleted: boolean;
  response?: unknown;
};

const COMPLETED_DEDUPE_CAPACITY = 32;

/**
 * Realtime SFU sessions each own one PeerConnection/SDP state machine.
 * This queue does not release a session after an SFU-generated offer until
 * the matching browser answer has been applied through /renegotiate.
 */
export class SessionMutationQueue {
  private readonly idleWaiters: Array<() => void> = [];
  private readonly inFlightResponses = new Map<string, Promise<unknown>>();
  private readonly mutationLedger = new Map<string, MutationLedgerEntry>();
  private readonly waiting: QueueItem[] = [];
  private active = false;
  private blocked?: BlockedMutation;
  private invalid?: SessionQueueError;
  private sealed?: SessionQueueError;

  constructor(
    private readonly answerTimeoutMs = 15_000,
    private readonly onTimeout?: (operationId: string) => void | Promise<void>,
  ) {}

  get blockedOperationId(): string | undefined {
    return this.blocked?.id;
  }

  get isSealed(): boolean {
    return Boolean(this.sealed);
  }

  onIdle(): Promise<void> {
    if (!this.active && !this.blocked && this.waiting.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  enqueue<Response, Answer = never>(
    id: string,
    run: () => Promise<MutationExecution<Response, Answer>>,
  ): Promise<Response> {
    if (this.invalid) {
      return Promise.reject(this.invalid);
    }
    if (this.sealed) {
      return Promise.reject(this.sealed);
    }
    const completed = this.mutationLedger.get(id);
    if (completed && "response" in completed) {
      this.rememberLedgerEntry(id, completed);
      return Promise.resolve(completed.response as Response);
    }
    if (completed) {
      this.mutationLedger.delete(id);
    }
    const existing = this.inFlightResponses.get(id);
    if (existing) {
      return existing as Promise<Response>;
    }

    let resolveResponse!: (value: unknown) => void;
    let rejectResponse!: (error: unknown) => void;
    const response = new Promise<unknown>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.inFlightResponses.set(id, response);
    this.waiting.push({
      id,
      reject: rejectResponse,
      resolve: resolveResponse,
      run: run as () => Promise<MutationExecution<unknown, unknown>>,
    });
    void this.pump();
    return response as Promise<Response>;
  }

  async complete<Answer>(id: string, answer: Answer): Promise<void> {
    const blocked = this.blocked;
    if (!blocked || blocked.id !== id) {
      const completed = this.mutationLedger.get(id);
      if (completed?.answerCompleted) {
        this.rememberLedgerEntry(id, completed);
        return;
      }
      throw new SessionQueueError(
        "negotiation_not_pending",
        "The negotiation is no longer pending; reconnect this media session.",
      );
    }
    if (!blocked.completing) {
      blocked.completing = blocked.waitForAnswer(answer);
    }
    try {
      await blocked.completing;
      this.releaseBlocked(blocked, true);
    } catch (error) {
      if (this.invalid) {
        this.releaseBlocked(blocked, false);
      } else if (this.blocked === blocked) {
        blocked.completing = undefined;
      }
      throw error;
    }
  }

  restoreBlocked<Answer>(
    id: string,
    waitForAnswer: (answer: Answer) => Promise<void>,
    remainingMs = this.answerTimeoutMs,
  ): void {
    if (this.invalid || this.blocked || this.active || this.waiting.length > 0) {
      throw new Error("Cannot restore a negotiation on an active or invalid queue.");
    }
    this.mutationLedger.delete(id);
    this.blocked = this.createBlock(
      id,
      waitForAnswer as (answer: unknown) => Promise<void>,
      remainingMs,
    );
  }

  invalidate(
    error = new SessionQueueError(
      "session_reconnect_required",
      "The media session must be reconnected before this operation can continue.",
    ),
  ): void {
    this.invalid = error;
    if (this.blocked) {
      clearTimeout(this.blocked.timeout);
      if (!this.blocked.completing) {
        this.mutationLedger.delete(this.blocked.id);
        this.blocked = undefined;
      }
    }
    for (const item of this.waiting.splice(0)) {
      this.inFlightResponses.delete(item.id);
      item.reject(error);
    }
    this.resolveIdle();
  }

  seal(
    error = new SessionQueueError(
      "session_closing",
      "This media session is closing and cannot accept another mutation.",
    ),
  ): void {
    this.sealed = error;
  }

  private createBlock(
    id: string,
    waitForAnswer: (answer: unknown) => Promise<void>,
    timeoutMs: number,
  ): BlockedMutation {
    const timeout = setTimeout(() => {
      const error = new SessionQueueError(
        "negotiation_timed_out",
        "The SDP answer did not arrive in time; reconnect this media session.",
      );
      this.invalidate(error);
      void this.onTimeout?.(id);
    }, Math.max(1, timeoutMs));
    return { id, timeout, waitForAnswer };
  }

  private async pump(): Promise<void> {
    if (this.active || this.blocked || this.invalid) {
      return;
    }
    const item = this.waiting.shift();
    if (!item) {
      this.resolveIdle();
      return;
    }
    this.active = true;
    try {
      const execution = await item.run();
      if (this.invalid) {
        this.inFlightResponses.delete(item.id);
        item.reject(this.invalid);
        return;
      }
      this.rememberResponse(item.id, execution.response);
      this.inFlightResponses.delete(item.id);
      item.resolve(execution.response);
      if (execution.waitForAnswer) {
        this.blocked = this.createBlock(
          item.id,
          execution.waitForAnswer,
          this.answerTimeoutMs,
        );
      }
    } catch (error) {
      this.inFlightResponses.delete(item.id);
      item.reject(error);
    } finally {
      this.active = false;
      if (!this.blocked) {
        void this.pump();
      }
      this.resolveIdle();
    }
  }

  private resolveIdle(): void {
    if (this.active || this.blocked || this.waiting.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private releaseBlocked(
    blocked: BlockedMutation,
    completed: boolean,
  ): void {
    if (this.blocked !== blocked) return;
    clearTimeout(blocked.timeout);
    if (completed && !this.invalid) {
      this.rememberCompletedAnswer(blocked.id);
    } else if (this.invalid) {
      this.mutationLedger.delete(blocked.id);
    }
    this.blocked = undefined;
    if (!this.invalid) void this.pump();
    this.resolveIdle();
  }

  private rememberCompletedAnswer(id: string): void {
    const completed = this.mutationLedger.get(id);
    this.rememberLedgerEntry(
      id,
      completed && "response" in completed
        ? { answerCompleted: true, response: completed.response }
        : { answerCompleted: true },
    );
  }

  private rememberResponse(id: string, response: unknown): void {
    this.rememberLedgerEntry(id, {
      answerCompleted: false,
      response,
    });
  }

  private rememberLedgerEntry(
    id: string,
    entry: MutationLedgerEntry,
  ): void {
    this.mutationLedger.delete(id);
    this.mutationLedger.set(id, entry);
    trimOldest(this.mutationLedger);
  }
}

function trimOldest<Value>(entries: Map<string, Value>): void {
  while (entries.size > COMPLETED_DEDUPE_CAPACITY) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}
