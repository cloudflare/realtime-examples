import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelListSchema, channelsSchema } from './channels.ts';
import { commandSchema } from './robot.ts';
import { deviceStartSchema } from './signaling.ts';

test('Zod rejects hostile control values and unrecognized commands', () => {
  for (const value of [
    { led: [-1, 0, 0] },
    { led: [256, 0, 0] },
    { led: [1.5, 0, 0] },
    { action: 'erase' },
    { action: 'pause', cmd: 'restart_device' },
  ]) {
    assert.equal(commandSchema.safeParse(value).success, false);
  }
  assert.deepEqual(commandSchema.parse({ led: [0, 10, 32] }), { led: [0, 10, 32] });
});

test('device offers retain the bounded startup contract', () => {
  const input = { bootId: 'a'.repeat(32), sessionDescription: { type: 'offer', sdp: 'v=0\r\n' } };
  assert.equal(deviceStartSchema.safeParse(input).success, true);
  assert.equal(deviceStartSchema.safeParse({ ...input, bootId: 'not-a-boot-id' }).success, false);
  assert.equal(
    deviceStartSchema.safeParse({
      ...input,
      sessionDescription: { type: 'offer', sdp: 'v=0' + 'x'.repeat(16000) },
    }).success,
    false,
  );
});

test('viewer channel reliability and IDs must be unambiguous', () => {
  const valid = [
    { id: 1, dataChannelName: 'robot' as const, ordered: true },
    { id: 3, dataChannelName: 'spectrum' as const, ordered: false, maxRetransmits: 0 },
  ];
  assert.deepEqual(channelListSchema.parse(valid), valid);
  assert.throws(() => channelListSchema.parse([valid[0], { ...valid[1], id: 1 }]));
  assert.throws(() => channelListSchema.parse([valid[0], { ...valid[1], ordered: true }]));
});

test('SFU responses need not echo requested channel reliability', () => {
  const response = channelsSchema.parse({
    channels: [
      { id: 1, dataChannelName: 'robot' },
      { id: 3, dataChannelName: 'spectrum' },
    ],
  });
  assert.deepEqual(response.channels, [
    { id: 1, dataChannelName: 'robot', ordered: true },
    { id: 3, dataChannelName: 'spectrum', ordered: false, maxRetransmits: 0 },
  ]);
  assert.equal(
    channelsSchema.safeParse({
      channels: [
        { id: 1, dataChannelName: 'robot', ordered: false },
        { id: 3, dataChannelName: 'spectrum' },
      ],
    }).success,
    false,
  );
});
