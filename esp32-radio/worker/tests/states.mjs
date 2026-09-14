// Actual App rendering with a fixture at its public React/session boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const output = new URL('../../artifacts/worker/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.RADIO_CDP_URL ?? 'http://127.0.0.1:19223',
);
const results = [];
const track = { title: 'Morning Radio', artist: 'Example Artist', durationMs: 240000 };
const nowPlaying = { revision: 1, trackIndex: 0, trackCount: 4, track };
const room = {
  online: true,
  viewers: 1,
  controller: null,
  generation: 'fixture',
  track,
  nowPlaying,
};
const telemetry = {
  event: 'telemetry',
  firmware: 'fixture',
  sequence: 1,
  uptimeMs: 20000,
  positionMs: 30000,
  durationMs: 240000,
  playbackRevision: 1,
  paused: false,
  rssi: -62,
  heap: 188000,
  hardware: {
    sampledAtMs: 19000,
    cpuBusyBps: [2200, 5100],
    chipTemperatureMc: 48000,
    internal: { free: 188000, minimumFree: 170000, largestBlock: 120000 },
    psram: { free: 14500000, minimumFree: 14000000, largestBlock: 13800000 },
    sampleCostUs: 220,
    samplerStackFree: 5000,
  },
  stackFree: 8000,
  led: [0, 24, 5],
  audioErrors: 0,
  dataErrors: 0,
  skippedFrames: 0,
};
const selectors = {
  audio: '[data-anchor="leaf-audio"]',
  spectrum: '[data-anchor="leaf-spectrum"]',
  controls: '[data-anchor="leaf-robot"]',
  connect: '#connect',
  sound: '[aria-label="Mute"], [aria-label="Unmute"], [aria-label="Enable sound"]',
  volume: '[aria-label="Listening volume"]',
};
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 0.6, `${label}: ${a} → ${b}`);
try {
  for (const width of [320, 390, 768, 1024, 1380]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    try {
      await context.route('**/api/**', (route) => route.abort());
      await context.route('**/src/client/radio/use-radio.ts*', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: 'export { useFixtureRadio as useRadio } from "/tests/fixtures/radio.tsx";',
        }),
      );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(process.env.RADIO_TEST_URL ?? 'http://localhost:11880');
      await page.getByTestId('track-title').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const measure = async () =>
        page.evaluate(
          (selectors) => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            boxes: Object.fromEntries(
              Object.entries(selectors).map(([key, selector]) => [
                key,
                (() => {
                  const box = document.querySelector(selector).getBoundingClientRect();
                  return { ...box.toJSON(), x: box.x + scrollX, y: box.y + scrollY };
                })(),
              ]),
            ),
          }),
          selectors,
        );
      const patch = async (data) => {
        await page.evaluate((data) => window.exhibitFixture.patch(data), data);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };
      const idle = await measure();
      assert.equal(idle.overflow, false);
      await page.locator('#connect').click();
      const connecting = await measure();
      assert.equal(connecting.overflow, false);
      await patch({
        phase: 'connected',
        viewerId: 'listener',
        telemetry,
        paused: false,
        led: telemetry.led,
        now: 10000,
        telemetryAt: 10000,
        audio: { packets: 1, bytes: 1000, kbps: 96, lost: 0, at: 10000 },
        message: 'Connected to the board.',
      });
      const connected = await measure();
      for (const next of [connecting, connected]) {
        for (const key of ['audio', 'spectrum', 'controls']) {
          near(idle.boxes[key].y, next.boxes[key].y, `${width} ${key} connection y`);
          near(idle.boxes[key].height, next.boxes[key].height, `${width} ${key} connection height`);
        }
      }
      for (const next of [connecting, connected])
        for (const key of ['connect', 'sound', 'volume']) {
          near(idle.boxes[key].x, next.boxes[key].x, `${width} ${key} x`);
          near(idle.boxes[key].width, next.boxes[key].width, `${width} ${key} width`);
        }
      await page.locator('#claim').focus();
      await page.keyboard.press('Enter');
      assert.equal(
        await page.locator('#claim').evaluate((el) => el === document.activeElement),
        true,
      );
      const calls = await page.evaluate(() => window.exhibitFixture.calls().length);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.exhibitFixture.calls().length), calls);
      await patch({ busy: false, room: { ...room, controller: 'listener' } });
      for (const selector of ['#pause', 'button[data-rgb="0,24,5"]']) {
        await patch({ ack: { state: 'idle', text: '', at: 0 } });
        await page.locator(selector).focus();
        await page.keyboard.press('Enter');
        assert.equal(
          await page.locator(selector).evaluate((el) => el === document.activeElement),
          true,
        );
        const count = await page.evaluate(() => window.exhibitFixture.calls().length);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.exhibitFixture.calls().length), count);
        await patch({
          ack: {
            state: 'confirmed',
            text: 'Board confirmed · 180 ms round trip',
            at: 10000,
            rtt: 180,
          },
        });
        assert.equal(
          await page.locator(selector).evaluate((el) => el === document.activeElement),
          true,
        );
      }
      const baseline = await measure();
      await patch({ audioBlocked: true });
      const blocked = await measure();
      near(baseline.boxes.audio.height, blocked.boxes.audio.height, `${width} sound recovery`);
      for (const changed of [
        { ...track, artist: '' },
        {
          title:
            'A long song title with extra edition notes (Live From The Festival, Extended Version)',
          artist: 'An Example Ensemble Featuring A Guest Vocalist',
          durationMs: 240000,
        },
        { title: 'A'.repeat(256), artist: 'B'.repeat(256), durationMs: 240000 },
      ]) {
        await patch({
          audioBlocked: false,
          nowPlaying: { ...nowPlaying, revision: 2, track: changed },
        });
        const metadata = await measure();
        assert.equal(metadata.overflow, false);
        near(baseline.boxes.audio.height, metadata.boxes.audio.height, `${width} metadata height`);
        await page
          .getByRole('button', { name: `Track information: ${changed.title}`, exact: true })
          .click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        assert.equal(await dialog.getByRole('heading').textContent(), changed.title);
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width);
        await page.keyboard.press('Escape');
        assert.equal(
          await page
            .getByRole('button', { name: `Track information: ${changed.title}`, exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
      }
      await patch({ nowPlaying, room, audioBlocked: false });
      await page.locator('#connect').click();
      const disconnected = await measure();
      near(idle.boxes.connect.width, disconnected.boxes.connect.width, `${width} disconnect width`);
      assert.equal(
        await page.locator('#connect').evaluate((el) => el === document.activeElement),
        true,
      );
      assert.deepEqual(errors, []);
      if (width === 390 || width === 1380)
        await page.screenshot({
          path: new URL(`states-${width}.png`, output).pathname,
          fullPage: true,
        });
      results.push({
        width,
        passed: true,
        buttonWidth: connected.boxes.connect.width,
        metadataHeight: baseline.boxes.audio.height,
        overflow: false,
        focusPreserved: true,
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await fs.writeFile(
    new URL('states-result.json', output),
    JSON.stringify(results, null, 2) + '\n',
  );
}
console.log(JSON.stringify(results, null, 2));
