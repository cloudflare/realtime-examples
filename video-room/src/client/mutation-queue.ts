export type RetryDecision = {
  delayMs: number;
  retry: boolean;
};

type QueueItem = {
  reject: (error: unknown) => void;
  resolve: () => void;
  run: () => Promise<void>;
};

/**
 * Browser-side SDP operations stay FIFO for the lifetime of one PeerConnection.
 * A task owns the queue through setRemoteDescription, createAnswer,
 * setLocalDescription, and the server /renegotiate acknowledgment.
 */
export class SerialMutationQueue {
  private active = false;
  private closeListeners = new Set<() => void>();
  private closed?: Error;
  private idleWaiters: Array<() => void> = [];
  private waiting: QueueItem[] = [];

  constructor(
    private readonly retryDecision: (
      error: unknown,
      attempt: number,
    ) => RetryDecision = () => ({ delayMs: 0, retry: false }),
  ) {}

  enqueue(run: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    const result = new Promise<void>((resolve, reject) => {
      this.waiting.push({ reject, resolve, run });
    });
    void this.pump();
    return result;
  }

  onIdle(): Promise<void> {
    if (!this.active && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(message = "The media session was replaced."): void {
    if (this.closed) return;
    this.closed = new Error(message);
    for (const item of this.waiting.splice(0)) item.reject(this.closed);
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.resolveIdle();
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    if (this.closed) {
      this.resolveIdle();
      return;
    }
    const item = this.waiting.shift();
    if (!item) {
      this.resolveIdle();
      return;
    }
    this.active = true;
    let attempt = 0;
    try {
      for (;;) {
        try {
          await item.run();
          item.resolve();
          break;
        } catch (error) {
          if (this.closed) {
            item.reject(this.closed);
            break;
          }
          const decision = this.retryDecision(error, attempt++);
          if (!decision.retry) {
            item.reject(error);
            break;
          }
          await this.waitForRetry(decision.delayMs);
          if (this.closed) {
            item.reject(this.closed);
            break;
          }
        }
      }
    } finally {
      this.active = false;
      if (this.closed) this.resolveIdle();
      else void this.pump();
    }
  }

  private waitForRetry(milliseconds: number): Promise<void> {
    if (milliseconds <= 0 || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        this.closeListeners.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, milliseconds);
      this.closeListeners.add(finish);
    });
  }

  private resolveIdle(): void {
    if (this.active || this.waiting.length > 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
