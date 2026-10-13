import { z } from 'zod';

const errorMessages: Record<string, string> = {
  incorrect_password: "That access code didn't work. Please try again.",
  login_required: 'Your session expired. Enter the access code to start another call.',
  setup_required: 'The app needs its server credentials before it can take calls.',
  too_many_attempts: 'Too many access-code attempts. Wait a minute and try again.',
  too_many_calls: 'Please wait a minute before starting another call.',
  sfu_unavailable: 'The audio connection could not be established. Please try again.',
  sfu_request_failed: 'The audio service could not finish connecting. Please try again.',
  session_error: 'The voice agent encountered a problem. Please start a new call.',
  service_unavailable: 'The service is temporarily unavailable. Please try again.',
  call_ended: 'This call has ended. You can start a new one.',
};

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(errorMessages[code] ?? 'The request could not be completed. Please try again.');
  }
}

const errorResponse = z.object({
  error: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  request_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { body?: unknown; signal?: AbortSignal; timeout?: number; keepalive?: boolean } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeout ?? 45_000);
  const response = await fetch(`/api/${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    keepalive: options.keepalive,
  });
  const value: unknown = response.ok
    ? await response.json()
    : await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorResponse.safeParse(value);
    if (response.status >= 500)
      console.error('[Voice API]', {
        status: response.status,
        code: parsed.success ? parsed.data.error : 'request_failed',
        callId: /^calls\/([a-f0-9]{32})\//.exec(path)?.[1],
        requestId: parsed.success ? parsed.data.request_id : undefined,
        ray: response.headers.get('cf-ray'),
      });
    throw new ApiError(parsed.success ? parsed.data.error : 'request_failed', response.status);
  }
  return schema.parse(value);
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return 'Allow microphone access in your browser, then try again.';
    if (error.name === 'NotFoundError')
      return 'No microphone was found. Connect one and try again.';
    if (error.name === 'NotReadableError')
      return "Your microphone is unavailable. Check that another app isn't using it.";
    if (error.name === 'TimeoutError')
      return 'Connecting took too long. Check your network and try again.';
  }
  if (error instanceof Error && error.name === 'MediaConnectionError') return error.message;
  return 'The call lost its connection. Please try again.';
}
