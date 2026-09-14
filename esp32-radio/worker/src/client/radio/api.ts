import type { z } from 'zod';
import { channelsSchema } from '@/shared/contracts/channels.ts';
import {
  audioResponseSchema,
  controllerSchema,
  joinedSchema,
  okSchema,
  statusSchema,
} from '@/shared/contracts/signaling.ts';
import type { Answer, ViewerCredentials } from '@/shared/contracts/signaling.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Each operation chooses its response schema; callers cannot assert a return type. */
export function createRadioApi(fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    input?: unknown,
    member?: ViewerCredentials,
  ): Promise<T> {
    const response = await fetcher(`/api${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(member ? { 'X-Viewer-Token': member.viewerToken } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(25000),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(response.status, 'Unreadable radio response. Try again.');
    }
    if (!response.ok) {
      const message =
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : 'Radio request failed. Try again.';
      throw new ApiError(response.status, message);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError(502, 'Unexpected radio response. Try again.');
    return parsed.data;
  }

  return {
    getStatus: () => request('/status', statusSchema),
    login: (password: string) => request('/login', okSchema, { password }),
    joinViewer: () => request('/viewers', joinedSchema, {}),
    answerViewer: (member: ViewerCredentials, answer: Answer) =>
      request(
        `/viewers/${member.id}/answer`,
        channelsSchema,
        { sessionDescription: answer },
        member,
      ),
    subscribeAudio: (member: ViewerCredentials) =>
      request(`/viewers/${member.id}/audio`, audioResponseSchema, {}, member),
    renegotiateViewer: (member: ViewerCredentials, answer: Answer) =>
      request(
        `/viewers/${member.id}/renegotiate`,
        okSchema,
        { sessionDescription: answer },
        member,
      ),
    heartbeatViewer: (member: ViewerCredentials) =>
      request(`/viewers/${member.id}/heartbeat`, controllerSchema, {}, member),
    claimControl: (member: ViewerCredentials) =>
      request(`/viewers/${member.id}/claim`, controllerSchema, {}, member),
    releaseControl: (member: ViewerCredentials) =>
      request(`/viewers/${member.id}/release`, controllerSchema, {}, member),
    leaveViewer: (member: ViewerCredentials) =>
      request(`/viewers/${member.id}/leave`, okSchema, {}, member),
  };
}

export type RadioApi = ReturnType<typeof createRadioApi>;
export const radioApi = createRadioApi();

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Connection failed. Try again.';
}
