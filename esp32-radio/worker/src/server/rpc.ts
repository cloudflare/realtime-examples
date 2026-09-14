export class OperationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function demand(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new OperationError(status, message);
}

/** Expected failures cross the RPC boundary as data, preserving status codes. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
