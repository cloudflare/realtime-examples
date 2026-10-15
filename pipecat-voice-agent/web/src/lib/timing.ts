import type { Timing } from './contracts';

export class StartupTimings {
  readonly started = performance.now();
  private serverOperations = new Set<string>();

  constructor(private onTiming: (timing: Timing) => void) {}

  async measure<T>(operation: string, label: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let status: 'ok' | 'failed' = 'ok';
    try {
      return await action();
    } catch (error) {
      status = 'failed';
      throw error;
    } finally {
      this.record({
        operation,
        label,
        status,
        source: 'browser',
        elapsed_ms: performance.now() - start,
        cumulative_ms: performance.now() - this.started,
      });
    }
  }

  server(rows: Omit<Timing, 'source'>[]) {
    for (const row of rows) {
      if (this.serverOperations.has(row.operation)) continue;
      this.serverOperations.add(row.operation);
      this.record({ ...row, source: 'server' });
    }
  }

  complete() {
    this.record({
      operation: 'startup_total',
      label: 'Ready to talk',
      status: 'ok',
      source: 'browser',
      elapsed_ms: performance.now() - this.started,
    });
  }

  private record(row: Timing) {
    row.elapsed_ms = Math.round(row.elapsed_ms * 10) / 10;
    if (row.cumulative_ms !== undefined)
      row.cumulative_ms = Math.round(row.cumulative_ms * 10) / 10;
    console.info('[Voice startup]', row.label, {
      source: row.source,
      status: row.status,
      elapsed_ms: row.elapsed_ms,
      cumulative_ms: row.cumulative_ms,
    });
    this.onTiming(row);
  }
}
