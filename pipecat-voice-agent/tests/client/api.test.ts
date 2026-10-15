import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { request } from '../../web/src/lib/api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('API failure reporting', () => {
  it('logs correlation metadata without the response payload or request credentials', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callId = 'b'.repeat(32);
    const requestId = 'a'.repeat(32);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: 'service_unavailable',
            request_id: requestId,
            transcript: 'private-transcript',
          },
          { status: 503, headers: { 'cf-ray': 'test-ray-SJC' } },
        ),
      ),
    );
    await expect(
      request(`calls/${callId}/finish?token=private-token`, z.object({}), {
        body: { private: 'private-request' },
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(report).toHaveBeenCalledExactlyOnceWith('[Voice API]', {
      status: 503,
      code: 'service_unavailable',
      callId,
      requestId,
      ray: 'test-ray-SJC',
    });
  });

  it('retains status and CF-Ray for a non-JSON platform failure', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>private response</html>', {
          status: 503,
          headers: { 'cf-ray': 'test-ray-SJC' },
        }),
      ),
    );
    await expect(request('session', z.object({}))).rejects.toMatchObject({
      code: 'request_failed',
      status: 503,
    });
    expect(report).toHaveBeenCalledExactlyOnceWith('[Voice API]', {
      status: 503,
      code: 'request_failed',
      callId: undefined,
      requestId: undefined,
      ray: 'test-ray-SJC',
    });
  });

  it('does not emit error logs for an expected authentication rejection', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'login_required' }, { status: 401 })),
    );
    await expect(request('session', z.object({}))).rejects.toMatchObject({
      code: 'login_required',
      status: 401,
    });
    expect(report).not.toHaveBeenCalled();
  });
});
