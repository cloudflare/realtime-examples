export const SAFETY_POLL_INTERVAL_MS = 15_000;

type ScheduleInterval = (
  callback: () => void,
  milliseconds: number,
) => unknown;
type CancelInterval = (handle: unknown) => void;

export class SafetyPoller {
  private handle?: unknown;

  constructor(
    private readonly poll: () => Promise<void> | void,
    private readonly intervalMs = SAFETY_POLL_INTERVAL_MS,
    private readonly schedule: ScheduleInterval = (callback, milliseconds) =>
      setInterval(callback, milliseconds),
    private readonly cancel: CancelInterval = (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  ) {}

  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.schedule(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.cancel(this.handle);
    this.handle = undefined;
  }
}
