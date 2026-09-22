import { z } from 'zod';
import { descriptionSchema } from '@/shared/contracts/signaling.ts';
import { demand, OperationError } from './rpc.ts';

const resultSchema = z.object({
  sessionId: z.string().optional(),
  sessionDescription: descriptionSchema.optional(),
  requiresImmediateRenegotiation: z.boolean().optional(),
  errorCode: z.string().optional(),
  dataChannels: z
    .array(
      z.object({
        id: z.number().int().optional(),
        dataChannelName: z.string().optional(),
        ordered: z.boolean().optional(),
        maxRetransmits: z.number().int().optional(),
        errorCode: z.string().optional(),
      }),
    )
    .optional(),
  tracks: z
    .array(
      z.object({
        mid: z.string().optional(),
        trackName: z.string().optional(),
        errorCode: z.string().optional(),
      }),
    )
    .optional(),
});
export type SfuResult = z.infer<typeof resultSchema>;

// A malformed sibling or SDP must not hide a valid allocation receipt.
const receiptsSchema = z
  .object({
    dataChannels: z
      .array(z.object({ id: z.number().int().min(0).max(65534).optional() }).catch({}))
      .catch([]),
    tracks: z.array(z.object({ mid: z.string().min(1).max(128).optional() }).catch({})).catch([]),
  })
  .catch({ dataChannels: [], tracks: [] });
export type AllocationReceipt = { channelIds: number[]; mids: string[] };

function diagnosticErrorCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unrecognized_error_code';
}

export class SfuClient {
  private env: Pick<Env, 'REALTIME_APP_ID' | 'REALTIME_APP_TOKEN'>;
  constructor(env: Pick<Env, 'REALTIME_APP_ID' | 'REALTIME_APP_TOKEN'>) {
    this.env = env;
  }
  async call(path: string, input?: unknown, method = 'POST'): Promise<SfuResult> {
    return this.request(path, input, method);
  }
  async allocate(
    path: string,
    input: unknown,
    retain: (receipt: AllocationReceipt) => Promise<void>,
  ): Promise<SfuResult> {
    return this.request(path, input, 'POST', retain);
  }
  async closeTracks(sessionId: string, mids: string[]): Promise<void> {
    await this.call(
      `/sessions/${sessionId}/tracks/close`,
      { tracks: mids.map((mid) => ({ mid })), force: true },
      'PUT',
    );
  }
  private async request(
    path: string,
    input: unknown,
    method: string,
    retain?: (receipt: AllocationReceipt) => Promise<void>,
  ): Promise<SfuResult> {
    let response: Response;
    try {
      response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(this.env.REALTIME_APP_ID)}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.env.REALTIME_APP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new OperationError(502, 'Could not reach the SFU. Please reconnect.');
    }
    const closing = path.endsWith('/close');
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OperationError(502, 'The SFU returned an unreadable response.');
    }
    if (retain) {
      const receipts = receiptsSchema.parse(payload);
      await retain({
        channelIds: [
          ...new Set(receipts.dataChannels.flatMap(({ id }) => (id === undefined ? [] : [id]))),
        ],
        mids: [...new Set(receipts.tracks.flatMap(({ mid }) => (mid === undefined ? [] : [mid])))],
      });
    }
    const parsed = resultSchema.safeParse(payload);
    demand(parsed.success, 502, 'The SFU returned an invalid response.');
    const value = parsed.data;
    const requested = closing ? receiptsSchema.parse(input) : undefined;
    // An item-level absence can satisfy cleanup; a request error does not locate it.
    const failed = (item: { errorCode?: string; mid?: string; id?: number }) =>
      item.errorCode &&
      !(
        item.errorCode === 'close_track_error' &&
        ((item.mid !== undefined && requested?.tracks.some(({ mid }) => mid === item.mid)) ||
          (item.id !== undefined && requested?.dataChannels.some(({ id }) => id === item.id)))
      );
    if (
      !response.ok ||
      value.errorCode ||
      value.tracks?.some(failed) ||
      value.dataChannels?.some(failed)
    ) {
      console.warn(
        JSON.stringify({
          phase: 'sfu',
          operation: path.split('/').slice(-2).join('/'),
          status: response.status,
          errorCode: value.errorCode ? diagnosticErrorCode(value.errorCode) : undefined,
          trackErrorCodes: value.tracks?.flatMap((item) =>
            item.errorCode ? [diagnosticErrorCode(item.errorCode)] : [],
          ),
          dataChannelErrorCodes: value.dataChannels?.flatMap((item) =>
            item.errorCode ? [diagnosticErrorCode(item.errorCode)] : [],
          ),
        }),
      );
    }
    demand(response.ok && !value.errorCode, 502, `SFU operation failed (${response.status}).`);
    demand(
      !value.dataChannels?.some(failed) && !value.tracks?.some(failed),
      502,
      'The SFU could not configure a channel or track.',
    );
    return value;
  }
}
