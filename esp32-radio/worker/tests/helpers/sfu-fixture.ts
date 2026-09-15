import { z } from 'zod';
import {
  answerSchema,
  descriptionSchema,
  joinedSchema,
  statusSchema,
} from '@/shared/contracts/signaling.ts';
import type { DeviceStart } from '@/shared/contracts/signaling.ts';

export const offer = {
  type: 'offer' as const,
  sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendonly\r\n',
};
export const answer = { ...offer, type: 'answer' as const };
export const track = { title: 'Test track', artist: 'Test artist', durationMs: 6000 };
export const nowPlaying = { revision: 0, trackIndex: 0, trackCount: 3, track };
export const bindings = {
  REALTIME_APP_ID: 'test-app',
  REALTIME_APP_TOKEN: 'example-sfu-token',
  DEVICE_TOKEN: 'test-device-token',
  VIEWER_PASSWORD: 'test-viewer-password',
  ROBOT_NAME: 'test-board',
};
export const device = { Authorization: `Bearer ${bindings.DEVICE_TOKEN}` };
export const startedSchema = z.object({ generation: z.uuid(), sessionDescription: answerSchema });
const inputSchema = z
  .object({
    sessionDescription: descriptionSchema.optional(),
    tracks: z
      .array(
        z
          .object({
            location: z.enum(['local', 'remote']).optional(),
            mid: z.string().optional(),
            trackName: z.string().optional(),
            sessionId: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    dataChannels: z
      .array(
        z
          .object({
            id: z.number().optional(),
            location: z.enum(['local', 'remote']).optional(),
            sessionId: z.string().optional(),
            dataChannelName: z.string().optional(),
            canReply: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type SfuCall = { path: string; input: z.infer<typeof inputSchema> };
export type Responder = (call: SfuCall) => Response | undefined | Promise<Response | undefined>;

export function createSfu(respond: Responder = () => undefined) {
  const calls: SfuCall[] = [];
  let allocated = 0;
  return {
    calls,
    allocations: () => allocated,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        url.hostname !== 'rtc.live.cloudflare.com' ||
        !url.pathname.startsWith('/v1/apps/test-app/') ||
        request.headers.get('Authorization') !== `Bearer ${bindings.REALTIME_APP_TOKEN}`
      ) {
        throw new Error('Unexpected outbound target or test credentials');
      }
      const text = await request.text();
      const input = inputSchema.parse(text ? JSON.parse(text) : {});
      const path = url.pathname,
        call = { path, input };
      calls.push(call);
      const response = await respond(call);
      if (response) return response;
      if (path.endsWith('/sessions/new'))
        return Response.json({ sessionId: `session-${++allocated}` });
      if (path.endsWith('/tracks/new'))
        return Response.json({
          sessionDescription: input.tracks[0].location === 'local' ? answer : offer,
          tracks: [{ mid: '0', trackName: 'music' }],
        });
      if (path.endsWith('/datachannels/establish'))
        return Response.json({ sessionDescription: offer, requiresImmediateRenegotiation: true });
      if (path.endsWith('/datachannels/new'))
        return Response.json({
          dataChannels: input.dataChannels.map((c, i) => ({
            dataChannelName: c.dataChannelName,
            id: c.location === 'local' ? 2 + i * 2 : 1 + i * 2,
          })),
        });
      if (path.endsWith('/datachannels/update'))
        return Response.json({ dataChannels: input.dataChannels.map((c) => ({ ...c, id: 1 })) });
      if (path.endsWith('/renegotiate') || path.endsWith('/close')) return Response.json({});
      throw new Error(`Unexpected test SFU operation: ${path}`);
    },
  };
}

export function createRadioClient(dispatch: (request: Request) => Promise<Response>) {
  let cookie: string | undefined;
  const call = async (path: string, input?: unknown, headers: Record<string, string> = {}) => {
    const response = await dispatch(
      new Request(`https://radio.example/api${path}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        ...(input === undefined
          ? {}
          : { body: typeof input === 'string' ? input : JSON.stringify(input) }),
      }),
    );
    // Drain runtime-backed bodies even when a case only inspects its status.
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  };
  async function successful(path: string, input: unknown, headers: Record<string, string> = {}) {
    const response = await call(path, input, headers);
    if (response.status !== 200)
      throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
    return response;
  }
  return {
    call,
    status: async () => statusSchema.parse(await (await call('/status')).json()),
    async login() {
      const response = await successful('/login', { password: bindings.VIEWER_PASSWORD });
      const header = response.headers.get('Set-Cookie');
      if (!header) throw new Error('Missing test login cookie');
      cookie = header.split(';')[0];
      return header;
    },
    async start(fields: Partial<DeviceStart> = { track }) {
      const input: DeviceStart = { sessionDescription: offer, bootId: 'a'.repeat(32), ...fields };
      const publisher = startedSchema.parse(
        await (await successful('/device/start', input, device)).json(),
      );
      const identity = { generation: publisher.generation };
      await successful('/device/channels', identity, device);
      await successful('/device/ready', identity, device);
      return { input, publisher, identity };
    },
    async viewer() {
      const viewer = joinedSchema.parse(await (await successful('/viewers', {})).json());
      const owner = { 'X-Viewer-Token': viewer.viewerToken };
      await successful(`/viewers/${viewer.id}/answer`, { sessionDescription: answer }, owner);
      return { ...viewer, owner };
    },
  };
}
