import { z } from 'zod';

export const CHANNEL_PROFILES = [
  { dataChannelName: 'robot', ordered: true },
  { dataChannelName: 'spectrum', ordered: false, maxRetransmits: 0 },
] as const;
// The SFU may return only id/name. Reliability is our requested configuration,
// not a mandatory echo in its response. Reject an explicit conflicting setting.
export const channelSchema = z
  .object({
    id: z.number().int().min(0).max(65534),
    dataChannelName: z.enum(['robot', 'spectrum']),
    ordered: z.boolean().optional(),
    maxRetransmits: z.number().int().nonnegative().optional(),
  })
  .refine(
    (channel) =>
      channel.ordered === undefined || channel.ordered === (channel.dataChannelName === 'robot'),
  )
  .refine(
    (channel) =>
      channel.maxRetransmits === undefined ||
      (channel.dataChannelName === 'spectrum' && channel.maxRetransmits === 0),
  )
  .transform((channel) => ({
    id: channel.id,
    ...CHANNEL_PROFILES.find((profile) => profile.dataChannelName === channel.dataChannelName)!,
  }));
export const channelListSchema = z
  .array(channelSchema)
  .length(2)
  .refine(
    (channels) =>
      new Set(channels.map((channel) => channel.id)).size === 2 &&
      new Set(channels.map((channel) => channel.dataChannelName)).size === 2,
  );
export const channelsSchema = z.object({ channels: channelListSchema });

export type Channel = z.infer<typeof channelSchema>;
