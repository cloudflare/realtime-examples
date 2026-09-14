import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newerTimestamp, parseRobot, parseSpectrum } from './protocol.ts';

function spectrum(pts: number, position: number, paused = false) {
  const frame = new ArrayBuffer(44);
  const data = new DataView(frame);
  data.setUint8(0, 1);
  data.setUint8(1, Number(paused));
  data.setUint32(4, pts, true);
  data.setUint32(8, position, true);
  new Uint8Array(frame, 12).fill(paused ? 0 : 127);
  return frame;
}

test('spectrum accepts track restart while rejecting duplicates and delayed packets', () => {
  const before = parseSpectrum(spectrum(5000, 5000))!;
  assert.equal(parseSpectrum(spectrum(5000, 5000), before.pts), undefined);
  assert.equal(parseSpectrum(spectrum(4980, 4980), before.pts), undefined);
  const restarted = parseSpectrum(spectrum(5040, 0), before.pts)!;
  assert.equal(restarted.positionMs, 0);
  assert.deepEqual(Array.from(restarted.bands), Array(32).fill(127));
});

test('spectrum handles a wrapping RTP clock and pause frames', () => {
  assert.equal(newerTimestamp(20, 0xfffffff0), true);
  assert.equal(newerTimestamp(0xfffffff0, 20), false);
  const paused = parseSpectrum(spectrum(20, 100, true), 0xfffffff0)!;
  assert.equal(paused.paused, true);
  assert.ok(paused.bands.every((value) => value === 0));
  assert.equal(parseSpectrum(new ArrayBuffer(43)), undefined);
  const unknownVersion = spectrum(40, 100);
  new DataView(unknownVersion).setUint8(0, 2);
  assert.equal(parseSpectrum(unknownVersion), undefined);
});

test('robot messages reject malformed JSON and invalid acknowledgments', () => {
  assert.equal(parseRobot('{'), undefined);
  assert.equal(parseRobot('x'.repeat(4097)), undefined);
  assert.equal(
    parseRobot(
      JSON.stringify({ event: 'ack', command_id: 'a', result: 0, led: [999, 0, 0], paused: false }),
    ),
    undefined,
  );
});
