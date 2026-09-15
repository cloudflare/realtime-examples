// Explicit hardware/SFU test. Keep capabilities, passwords, and SDP out of output.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright-core';

const url = process.env.RADIO_TEST_URL ?? 'http://localhost:11880';
const { VIEWER_PASSWORD: password } = parseEnv(
  await fs.readFile(new URL('../../.credential.env', import.meta.url), 'utf8'),
);
assert.ok(password, 'Set VIEWER_PASSWORD in .credential.env before running the live test.');
const browser = await chromium.connectOverCDP(
  process.env.RADIO_CDP_URL ?? 'http://127.0.0.1:19223',
);
const contexts = [],
  pages = [],
  errors = [];
const result = { receivers: [] };
let staticTrackRequests = 0;
const output = new URL('../../artifacts/worker/', import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
  for (const width of [1380, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 1100 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__peers = [];
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(...args) {
          super(...args);
          this.__channels = [];
          window.__peers.push(this);
        }
        createDataChannel(...args) {
          const channel = super.createDataChannel(...args);
          this.__channels.push(channel);
          channel.addEventListener('message', (event) => {
            if (channel.label === 'robot') {
              try {
                const value = JSON.parse(event.data);
                if (value.event === 'telemetry') this.__telemetry = value;
                if (value.event === 'nowPlaying') this.__nowPlaying = value.nowPlaying;
              } catch {}
            }
            if (
              channel.label === 'spectrum' &&
              event.data instanceof ArrayBuffer &&
              (event.data.byteLength === 44 || event.data.byteLength === 48)
            ) {
              const view = new DataView(event.data);
              this.__spectrum = {
                pts: view.getUint32(4, true),
                position: view.getUint32(8, true),
                paused: !!view.getUint8(1),
                bands: Array.from(new Uint8Array(event.data, 12, 32)),
                revision: event.data.byteLength === 48 ? view.getUint32(44, true) : undefined,
              };
            }
          });
          return channel;
        }
      };
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/track.json') staticTrackRequests++;
    });
    await page.goto(url);
    await page.waitForFunction(
      () =>
        document.querySelector('input[name="password"]') ||
        !document.querySelector('#connect')?.disabled,
    );
    if (await page.getByLabel('Viewer password', { exact: true }).count()) {
      await page.getByLabel('Viewer password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Unlock exhibit' }).click();
    }
    await page.locator('#connect').waitFor();
    await page.waitForFunction(() => !document.querySelector('#connect').disabled);
    if (process.env.RADIO_EXPECT_TRACK) {
      await page.waitForFunction(
        (title) => document.querySelector('[data-testid="track-title"]')?.textContent === title,
        process.env.RADIO_EXPECT_TRACK,
        { timeout: 15000 },
      );
      result.metadataBeforeListening = true;
    }
    await page.locator('#connect').click();
    await page.waitForFunction(
      () => document.querySelector('#connect').textContent.includes('Disconnect'),
      null,
      { timeout: 60000 },
    );
    await page.waitForFunction(
      () => window.__peers.at(-1)?.__spectrum?.bands.some((x) => x > 0),
      null,
      { timeout: 15000 },
    );
  }
  await pages[0].waitForTimeout(3500);
  for (const page of pages) {
    await page.waitForFunction(
      () => {
        const h = window.__peers.at(-1).__telemetry?.hardware;
        return h && h.cpuBusyBps.every((value) => value !== null) && h.chipTemperatureMc !== null;
      },
      undefined,
      { timeout: 15000 },
    );
    const sample = await page.evaluate(async () => {
      const peer = window.__peers.at(-1),
        report = await peer.getStats();
      let inbound, codec;
      report.forEach((stat) => {
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
          inbound = stat;
          codec = report.get(stat.codecId);
        }
      });
      return {
        connection: peer.connectionState,
        packets: inbound?.packetsReceived,
        energy: inbound?.totalAudioEnergy,
        codec: codec?.mimeType,
        firmware: peer.__telemetry?.firmware,
        music: peer.__telemetry?.music,
        hardware: peer.__telemetry?.hardware,
        uptimeMs: peer.__telemetry?.uptimeMs,
        hasRandom: Object.hasOwn(peer.__telemetry, 'random'),
        nowPlaying: peer.__nowPlaying,
        peerCount: window.__peers.length,
        source: peer.__telemetry?.spectrum?.source,
        core: peer.__telemetry?.spectrum?.core,
        audioTime: document.querySelector('audio').currentTime,
        overflow: document.documentElement.scrollWidth > innerWidth,
        wires: document.querySelectorAll('.wire-track').length,
        liveWires: document.querySelectorAll('.wire-flow').length,
        trackTitle: document.querySelector('[data-testid="track-title"]').textContent,
      };
    });
    result.receivers.push(sample);
    assert.equal(sample.connection, 'connected');
    assert.ok(sample.packets > 100);
    assert.ok(sample.energy > 0);
    assert.equal(sample.codec.toLowerCase(), 'audio/opus');
    assert.equal(sample.firmware, 'rust');
    assert.equal(sample.hasRandom, false);
    assert.ok(
      sample.hardware.cpuBusyBps.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 10000,
      ),
    );
    assert.ok(
      sample.hardware.chipTemperatureMc >= -10000 && sample.hardware.chipTemperatureMc <= 80000,
    );
    assert.ok(sample.hardware.internal.free > 0);
    assert.ok(sample.hardware.psram.free > 0 && sample.hardware.psram.free <= 16 * 1024 * 1024);
    assert.ok(sample.uptimeMs - sample.hardware.sampledAtMs <= 3000);
    assert.equal(sample.source, 'fft');
    assert.equal(sample.core, 1);
    assert.ok(sample.audioTime > 1);
    assert.equal(sample.overflow, false);
  }
  assert.equal(result.receivers[0].wires, 6);
  assert.ok(result.receivers[0].liveWires >= 6);
  await pages[0].getByRole('button', { name: 'Spectrum', exact: true }).click();
  await pages[0].getByRole('heading', { name: 'Live spectrum' }).waitFor();
  await pages[0].getByRole('button', { name: 'Close signal explanation' }).click();
  result.pathInspection = true;
  await pages[0].getByRole('button', { name: 'Mute', exact: true }).click();
  assert.equal(await pages[0].locator('audio').evaluate((el) => el.muted), true);
  assert.equal(await pages[1].locator('audio').evaluate((el) => el.muted), false);
  await pages[0].getByRole('button', { name: 'Unmute', exact: true }).click();
  result.personalAudio = true;
  if (process.env.RADIO_EXPECT_AUTO_ADVANCE) {
    const before = await pages[0].evaluate(() => ({
      revision: window.__peers.at(-1).__nowPlaying.revision,
      pts: window.__peers.at(-1).__spectrum.pts,
    }));
    await pages[0].waitForFunction(
      (revision) => window.__peers.at(-1).__nowPlaying.revision !== revision,
      before.revision,
      { timeout: 45000 },
    );
    await pages[0].waitForFunction(
      () =>
        window.__peers.at(-1).__spectrum?.revision === window.__peers.at(-1).__nowPlaying.revision,
    );
    assert.ok(
      await pages[0].evaluate(
        (pts) => window.__peers.length === 1 && window.__peers.at(-1).__spectrum.pts > pts,
        before.pts,
      ),
    );
    result.automaticAdvanceWithoutReconnect = true;
  }

  await pages[0].locator('#claim').click();
  await pages[0].getByRole('button', { name: 'Set LED to blue' }).click();
  await pages[0].waitForFunction(() =>
    document.querySelector('[data-testid="ack"]').textContent.includes('Board confirmed'),
  );
  await pages[1].waitForFunction(
    () =>
      document.querySelector('[data-testid="board-led"]').getAttribute('data-rgb') === '0,10,32',
  );
  assert.equal(await pages[1].getByRole('button', { name: 'Set LED to coral' }).isDisabled(), true);
  result.ledAndSpectator = true;
  await pages[0].locator('#pause').click();
  await pages[0].waitForFunction(
    () =>
      window.__peers.at(-1).__spectrum?.paused &&
      window.__peers.at(-1).__spectrum.bands.every((x) => x === 0),
  );

  if (process.env.RADIO_EXPECT_PLAYLIST) {
    const before = await pages[0].evaluate(() => ({
      ...window.__peers.at(-1).__nowPlaying,
      pts: window.__peers.at(-1).__spectrum.pts,
    }));
    assert.ok(before.trackCount > 1);
    assert.equal(await pages[1].locator('#next-track').isDisabled(), true);
    await pages[0].locator('#next-track').click();
    for (const page of pages) {
      await page.waitForFunction(
        (expected) =>
          window.__peers.at(-1).__nowPlaying.trackIndex === expected &&
          window.__peers.at(-1).__spectrum?.revision ===
            window.__peers.at(-1).__nowPlaying.revision,
        (before.trackIndex + 1) % before.trackCount,
      );
      assert.equal(
        await page.getByTestId('track-title').textContent(),
        await page.evaluate(() => window.__peers.at(-1).__nowPlaying.track?.title ?? 'Music'),
      );
      assert.equal(await page.evaluate(() => window.__peers.length), 1);
      assert.ok(
        await page.evaluate((pts) => window.__peers.at(-1).__spectrum.pts > pts, before.pts),
      );
    }
    result.nextTrackWithoutReconnect = true;
  }
  await pages[0].getByRole('button', { name: 'Resume track' }).click();
  await pages[0].waitForFunction(
    () =>
      !window.__peers.at(-1).__spectrum?.paused &&
      window.__peers.at(-1).__spectrum.bands.some((x) => x > 0),
  );
  await pages[0].locator('#restart').click();
  await pages[0].waitForFunction(() => window.__peers.at(-1).__spectrum.position < 1000);
  result.pauseResumeRestart = true;
  await pages[0].locator('#claim').click();
  await pages[1].waitForFunction(() => !document.querySelector('#claim').disabled);
  await pages[1].locator('#claim').click();
  await pages[1].getByRole('button', { name: 'Set LED to green' }).click();
  await pages[1].waitForFunction(() =>
    document.querySelector('[data-testid="ack"]').textContent.includes('Board confirmed'),
  );
  result.mobileHandoff = true;
  for (let i = 0; i < pages.length; i++) {
    await pages[i].screenshot({
      path: new URL(i ? 'mobile-live.png' : 'desktop-live.png', output).pathname,
      fullPage: true,
    });
  }
  await pages[1].locator('#claim').click();
  for (const page of pages) await page.locator('#connect').click();
  result.passed = true;
  assert.equal(staticTrackRequests, 0);
  result.noStaticTrackManifest = true;
  assert.deepEqual(errors, []);
} catch (error) {
  result.passed = false;
  result.error = error.message;
  process.exitCode = 1;
  for (let i = 0; i < pages.length; i++) {
    result[`page${i}`] = (
      await pages[i]
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(-1800);
    await pages[i]
      .screenshot({ path: new URL(`failure-${i}.png`, output).pathname, fullPage: true })
      .catch(() => {});
  }
} finally {
  result.errors = errors;
  await fs.writeFile(new URL('live-result.json', output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  for (const context of contexts) await context.close();
  await browser.close();
}
