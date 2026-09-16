import { demand, OperationError } from './rpc.ts';
import type { RpcResult } from './rpc.ts';
import type { z } from 'zod';

export type HttpApp = { Bindings: Env; Variables: { requestId: string } };

export function parse<T>(schema: z.ZodType<T>, value: unknown, message = 'Invalid request.'): T {
  const result = schema.safeParse(value);
  // Zod issues may contain sensitive input: never send them to a log or client.
  if (!result.success) throw new OperationError(400, message);
  return result.data;
}
export async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  demand(reader, 400, 'Expected a JSON request.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 20000) {
      await reader.cancel();
      throw new OperationError(413, 'Request too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OperationError(400, 'Invalid JSON request.');
  }
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function rpcResponse<T>(result: RpcResult<T>, requestId: string): Response {
  return result.ok
    ? json(result.value, 200, { 'X-Request-Id': requestId })
    : json({ error: result.error, requestId }, result.status);
}
