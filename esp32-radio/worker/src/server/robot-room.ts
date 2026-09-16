import { startupMetadata, checkStartupMetadata, heartbeatMetadata } from './publisher-metadata.ts';
import type { NowPlaying } from '@/shared/contracts/track.ts';
import { DurableObject } from 'cloudflare:workers';
import { answerSchema, offerSchema } from '@/shared/contracts/signaling.ts';
import { CHANNEL_PROFILES, channelListSchema } from '@/shared/contracts/channels.ts';
import type {
  Description,
  DeviceStart,
  RoomStatus,
  ViewerKey,
} from '@/shared/contracts/signaling.ts';
import { digest } from './crypto.ts';
import { demand, OperationError } from './rpc.ts';
import type { RpcResult } from './rpc.ts';
import type { Publisher, RoomState, SessionResources, Viewer } from './room-state.ts';
import { SfuClient } from './sfu.ts';
import type { AllocationReceipt, SfuResult } from './sfu.ts';

/** One physical board, its publisher, its viewers, and one renewable controller. */
export class RobotRoom extends DurableObject<Env> {
  private state: RoomState = { viewers: {} };
  private tail: Promise<void> = Promise.resolve();
  private sfu: SfuClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sfu = new SfuClient(env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('room')) ?? { viewers: {} };
    });
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private run<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
    return this.serialize(async () => {
      try {
        return { ok: true, value: await fn() };
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return { ok: false, status: error.status, error: error.message };
      } finally {
        await this.save();
      }
    });
  }
  private async save(): Promise<void> {
    await this.ctx.storage.put('room', this.state);
    if (this.state.publisher || Object.keys(this.state.viewers).length) {
      const next = Date.now() + 10000,
        scheduled = await this.ctx.storage.getAlarm();
      // Polling must not push an already scheduled cleanup farther into the future.
      if (!scheduled || scheduled > next) await this.ctx.storage.setAlarm(next);
    } else await this.ctx.storage.deleteAlarm();
  }
  private publisher(): Publisher {
    const p = this.state.publisher;
    demand(
      p?.ready && Date.now() - p.seen < 25000,
      409,
      'The board is offline. Try again when it is online.',
    );
    return p;
  }
  private viewer(key: ViewerKey): Viewer {
    const v = this.state.viewers[key.id];
    demand(v && key.token === v.token, 403, 'This browser does not own that viewer session.');
    demand(
      !v.closing && v.generation === this.state.publisher?.generation,
      409,
      'The S3 session changed. Reconnect to the radio.',
    );
    v.seen = Date.now();
    return v;
  }
  private device(generation: string): Publisher {
    const p = this.state.publisher;
    demand(p && generation === p.generation, 409, 'Device generation is no longer current.');
    p.seen = Date.now();
    return p;
  }
  private channels(result: SfuResult) {
    const parsed = channelListSchema.safeParse(result.dataChannels);
    demand(parsed.success, 502, 'The SFU did not return both data channels.');
    return parsed.data;
  }
  private async permission(v: Viewer, enabled: boolean): Promise<void> {
    const p = this.state.publisher;
    if (!p || !v.channels.length) return;
    await this.sfu.call(
      `/sessions/${v.sessionId}/datachannels/update`,
      {
        dataChannels: [
          {
            location: 'remote',
            sessionId: p.sessionId,
            dataChannelName: 'robot',
            canReply: enabled,
          },
        ],
      },
      'PUT',
      !enabled,
    );
  }
  private async retain(session: SessionResources, receipt: AllocationReceipt): Promise<void> {
    if (receipt.channelIds.length)
      session.pendingChannels = [
        ...new Set([...(session.pendingChannels ?? []), ...receipt.channelIds]),
      ];
    if (receipt.mids.length)
      session.pendingMids = [...new Set([...(session.pendingMids ?? []), ...receipt.mids])];
    if (receipt.channelIds.length || receipt.mids.length) await this.save();
  }
  private async closePending(session: SessionResources): Promise<boolean> {
    let ok = true;
    if (session.pendingChannels?.length) {
      try {
        await this.sfu.call(
          `/sessions/${session.sessionId}/datachannels/close`,
          {
            dataChannels: session.pendingChannels.map((id) => ({ id })),
          },
          'PUT',
        );
        delete session.pendingChannels;
      } catch {
        ok = false;
      }
    }
    if (session.pendingMids?.length) {
      try {
        await this.sfu.call(
          `/sessions/${session.sessionId}/tracks/close`,
          {
            tracks: session.pendingMids.map((mid) => ({ mid })),
            force: true,
          },
          'PUT',
        );
        delete session.pendingMids;
      } catch {
        ok = false;
      }
    }
    return ok;
  }
  private async openChannels(session: SessionResources, dataChannels: unknown) {
    if (!session.channels.length) {
      demand(
        await this.closePending(session),
        502,
        'Previous channel allocations are still closing. Try again.',
      );
      const result = await this.sfu.allocate(
        `/sessions/${session.sessionId}/datachannels/new`,
        { dataChannels },
        (receipt) => this.retain(session, receipt),
      );
      session.channels = this.channels(result);
      delete session.pendingChannels;
    }
    return { channels: session.channels };
  }
  private async close(session: SessionResources): Promise<boolean> {
    let ok = await this.closePending(session);
    if (session.channels.length) {
      try {
        await this.sfu.call(
          `/sessions/${session.sessionId}/datachannels/close`,
          { dataChannels: session.channels.map(({ id }) => ({ id })) },
          'PUT',
        );
        session.channels = [];
      } catch {
        ok = false;
      }
    }
    if (session.mid) {
      try {
        await this.sfu.call(
          `/sessions/${session.sessionId}/tracks/close`,
          { tracks: [{ mid: session.mid }], force: true },
          'PUT',
        );
        delete session.mid;
      } catch {
        ok = false;
      }
    }
    return ok;
  }
  private async expire(): Promise<void> {
    const controller = this.state.controller;
    if (controller && controller.until <= Date.now()) {
      const v = this.state.viewers[controller.id];
      if (v) await this.permission(v, false);
      delete this.state.controller;
    }
    for (const [id, v] of Object.entries(this.state.viewers)) {
      if (v.closing || Date.now() - v.seen > 45000) {
        v.closing = true;
        if (await this.close(v)) delete this.state.viewers[id];
      }
    }
    const p = this.state.publisher;
    if (p && Date.now() - p.seen > 90000) {
      p.ready = false;
      if (await this.close(p)) delete this.state.publisher;
    }
  }
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      try {
        await this.expire();
      } finally {
        await this.save();
      }
    });
  }

  getStatus(): Promise<RpcResult<RoomStatus>> {
    return this.run(async () => {
      const p = this.state.publisher,
        online = !!p?.ready && Date.now() - p.seen < 25000;
      return {
        online,
        viewers: Object.values(this.state.viewers).filter(
          (v) => !v.closing && Date.now() - v.seen < 45000,
        ).length,
        controller:
          this.state.controller && this.state.controller.until > Date.now()
            ? this.state.controller.id
            : null,
        generation: online ? p!.generation : null,
        track: online ? (p!.track ?? null) : null,
        nowPlaying: online ? (p!.nowPlaying ?? null) : null,
      };
    });
  }
  startDevice(input: DeviceStart) {
    return this.run(async () => {
      const offer = input.sessionDescription,
        bootId = input.bootId;
      const metadata = startupMetadata(input);
      const offerHash = bootId ? await digest(offer.sdp) : undefined;
      const existing = this.state.publisher;
      if (bootId && existing?.bootId === bootId) {
        demand(
          existing.offerHash === offerHash,
          409,
          'A boot identifier cannot be reused with another offer.',
        );
        checkStartupMetadata(existing, metadata);
        demand(
          existing.answer,
          409,
          'This startup did not complete. Restart the device to recover.',
        );
        existing.seen = Date.now();
        return { generation: existing.generation, sessionDescription: existing.answer };
      }
      const audio = offer.sdp.split(/\r?\nm=/).find((section) => section.startsWith('audio '));
      const mid = audio?.match(/(?:^|\n)a=mid:([^\r\n]+)/)?.[1];
      demand(
        mid && /^[A-Za-z0-9_-]{1,32}$/.test(mid),
        400,
        'The S3 offer must contain an audio track.',
      );
      for (const [id, v] of Object.entries(this.state.viewers)) {
        v.closing = true;
        demand(await this.close(v), 502, 'Previous viewers are still closing. Try again.');
        delete this.state.viewers[id];
      }
      if (this.state.publisher)
        demand(
          await this.close(this.state.publisher),
          502,
          'The previous publisher is still closing. Try again.',
        );
      delete this.state.controller;
      const session = await this.sfu.call('/sessions/new');
      demand(session.sessionId, 502, 'The SFU did not create a publisher session.');
      const p: Publisher = {
        sessionId: session.sessionId,
        generation: crypto.randomUUID(),
        mid,
        ready: false,
        seen: Date.now(),
        channels: [],
        bootId,
        offerHash,
        ...metadata,
        initialNowPlaying: input.nowPlaying,
      };
      this.state.publisher = p;
      const published = await this.sfu.allocate(
        `/sessions/${p.sessionId}/tracks/new`,
        {
          sessionDescription: offer,
          tracks: [{ location: 'local', mid, trackName: 'music' }],
        },
        (receipt) => this.retain(p, receipt),
      );
      const answer = answerSchema.safeParse(published.sessionDescription);
      demand(answer.success, 502, 'The SFU did not return a publisher answer.');
      p.answer = answer.data;
      p.pendingMids = p.pendingMids?.filter((value) => value !== mid);
      return { generation: p.generation, sessionDescription: p.answer };
    });
  }
  createDeviceChannels(generation: string) {
    return this.run(async () => {
      const p = this.device(generation);
      return this.openChannels(
        p,
        CHANNEL_PROFILES.map((profile) => ({ ...profile, location: 'local' })),
      );
    });
  }
  deviceReady(generation: string) {
    return this.run(async () => {
      const p = this.device(generation);
      demand(p.channels.length === 2, 409, 'Device channels are missing.');
      p.ready = true;
      return { ok: true as const };
    });
  }
  deviceHeartbeat(value: string | { generation: string; nowPlaying?: NowPlaying }) {
    return this.run(async () => {
      // Accept the earlier RPC shape during a compatible Worker rollout.
      const input = typeof value === 'string' ? { generation: value } : value;
      const p = this.device(input.generation);
      if (input.nowPlaying) {
        p.nowPlaying = heartbeatMetadata(p.nowPlaying, input.nowPlaying);
        p.track = p.nowPlaying.track ?? undefined;
      }
      return { ok: true as const };
    });
  }

  joinViewer() {
    return this.run(async () => {
      const p = this.publisher();
      await this.expire();
      demand(
        Object.keys(this.state.viewers).length < 8,
        429,
        'All 8 listener spots are in use. Try again later.',
      );
      const session = await this.sfu.call('/sessions/new');
      demand(session.sessionId, 502, 'The SFU did not create a viewer session.');
      const id = crypto.randomUUID(),
        token = crypto.randomUUID();
      this.state.viewers[id] = {
        sessionId: session.sessionId,
        token,
        generation: p.generation,
        seen: Date.now(),
        channels: [],
      };
      const transport = await this.sfu.call(
        `/sessions/${session.sessionId}/datachannels/establish`,
        { dataChannel: { location: 'remote', dataChannelName: 'server-events' } },
      );
      const offer = offerSchema.safeParse(transport.sessionDescription);
      demand(offer.success, 502, 'The SFU did not return a viewer offer.');
      return { id, viewerToken: token, generation: p.generation, sessionDescription: offer.data };
    });
  }
  answerViewer(key: ViewerKey, answer: Description) {
    return this.run(async () => {
      const v = this.viewer(key),
        p = this.publisher();
      await this.sfu.call(
        `/sessions/${v.sessionId}/renegotiate`,
        { sessionDescription: answer },
        'PUT',
      );
      return this.openChannels(
        v,
        CHANNEL_PROFILES.map((profile) => ({
          ...profile,
          location: 'remote',
          sessionId: p.sessionId,
          waitForAck: true,
          canReply: false,
        })),
      );
    });
  }
  subscribeAudio(key: ViewerKey) {
    return this.run(async () => {
      const v = this.viewer(key),
        p = this.publisher();
      demand(!v.mid, 409, 'Audio is already subscribed.');
      demand(
        await this.closePending(v),
        502,
        'Previous audio allocations are still closing. Try again.',
      );
      const result = await this.sfu.allocate(
        `/sessions/${v.sessionId}/tracks/new`,
        {
          tracks: [{ location: 'remote', sessionId: p.sessionId, trackName: 'music' }],
        },
        (receipt) => this.retain(v, receipt),
      );
      const mid = result.tracks?.[0]?.mid;
      const offer = offerSchema.safeParse(result.sessionDescription);
      demand(offer.success && mid, 502, 'The SFU did not return an audio offer.');
      v.mid = mid;
      v.pendingMids = v.pendingMids?.filter((value) => value !== mid);
      return { sessionDescription: offer.data };
    });
  }
  renegotiateViewer(key: ViewerKey, answer: Description) {
    return this.run(async () => {
      const v = this.viewer(key);
      this.publisher();
      await this.sfu.call(
        `/sessions/${v.sessionId}/renegotiate`,
        { sessionDescription: answer },
        'PUT',
      );
      return { ok: true as const };
    });
  }
  heartbeatViewer(key: ViewerKey) {
    return this.run(async () => {
      this.viewer(key);
      this.publisher();
      if (this.state.controller?.id === key.id && this.state.controller.until > Date.now())
        this.state.controller.until = Date.now() + 15000;
      return {
        controller:
          this.state.controller && this.state.controller.until > Date.now()
            ? this.state.controller.id
            : null,
      };
    });
  }
  claimControl(key: ViewerKey) {
    return this.run(async () => {
      const v = this.viewer(key);
      this.publisher();
      await this.expire();
      demand(
        !this.state.controller || this.state.controller.id === key.id,
        409,
        'Another listener has control. Try again when it is available.',
      );
      demand(v.channels.length === 2, 409, 'Wait for the data channels to open.');
      await this.permission(v, true);
      this.state.controller = { id: key.id, until: Date.now() + 15000 };
      return { controller: key.id };
    });
  }
  releaseControl(key: ViewerKey) {
    return this.run(async () => {
      const v = this.viewer(key);
      this.publisher();
      if (this.state.controller?.id === key.id) {
        await this.permission(v, false);
        delete this.state.controller;
      }
      return { controller: this.state.controller?.id ?? null };
    });
  }
  leaveViewer(key: ViewerKey) {
    return this.run(async () => {
      const v = this.viewer(key);
      if (this.state.controller?.id === key.id) {
        await this.permission(v, false);
        delete this.state.controller;
      }
      v.closing = true;
      if (await this.close(v)) delete this.state.viewers[key.id];
      return { ok: true as const };
    });
  }
}
