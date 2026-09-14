import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hardwareSchema } from './hardware.ts';
import { telemetrySchema } from './robot.ts';

const hardware = {
  sampledAtMs: 1000,
  cpuBusyBps: [null, 2500],
  chipTemperatureMc: 48000,
  internal: { free: 200000, minimumFree: 190000, largestBlock: 160000 },
  psram: { free: 14000000, minimumFree: 13000000, largestBlock: 12000000 },
  sampleCostUs: 200,
  samplerStackFree: 5000,
};

test('hardware values preserve unavailable readings and reject invalid units or bounds', () => {
  assert.deepEqual(hardwareSchema.parse(hardware), hardware);
  assert.equal(
    hardwareSchema.parse({ ...hardware, chipTemperatureMc: null }).chipTemperatureMc,
    null,
  );
  for (const patch of [
    { cpuBusyBps: [10001, 0] },
    { cpuBusyBps: [0] },
    { chipTemperatureMc: 90000 },
    { sampleCostUs: -1 },
  ]) {
    assert.equal(hardwareSchema.safeParse({ ...hardware, ...patch }).success, false);
  }
});

test('the telemetry contract accepts old publishers without making random a displayed metric', () => {
  const legacy = {
    event: 'telemetry',
    firmware: 'rust',
    sequence: 1,
    random: 123,
    uptimeMs: 1000,
    positionMs: 0,
    durationMs: 2000,
    paused: false,
    rssi: -60,
    heap: 200000,
    led: [0, 0, 0],
    audioErrors: 0,
    dataErrors: 0,
    skippedFrames: 0,
  };
  const parsed = telemetrySchema.parse(legacy);
  assert.equal('random' in parsed, false);
  assert.equal(parsed.hardware, undefined);
  assert.equal(telemetrySchema.parse({ ...legacy, hardware, rssi: null }).rssi, null);
});
