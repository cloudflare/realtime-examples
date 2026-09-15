// Visual/accessibility states with an explicitly offline board fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
await fs.mkdir('../artifacts/worker', { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.RADIO_CDP_URL ?? 'http://127.0.0.1:19223',
);
const contexts = [],
  result = { viewports: [] },
  errors = [];
try {
  for (const width of [320, 390, 768, 1024, 1380]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
    });
    contexts.push(context);
    await context.route('**/api/status', (route) =>
      route.fulfill({ json: { online: false, viewers: 0, controller: null, generation: null } }),
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.RADIO_TEST_URL ?? 'http://localhost:11880');
    await page.getByText('Board offline.', { exact: false }).waitFor();
    assert.equal(await page.locator('#connect').isDisabled(), true);
    assert.equal(await page.getByTestId('chip-temperature').textContent(), '–– °C');
    await page.getByRole('button', { name: 'Spectrum', exact: true }).click();
    await page.getByRole('heading', { name: 'Live spectrum' }).waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const metrics = await page.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      allButtonWidths: [...document.querySelectorAll('button')]
        .filter((x) => x.checkVisibility())
        .map((x) => Math.round(x.getBoundingClientRect().width)),
      motion: [...document.querySelectorAll('.wire-flow')].map(
        (x) => getComputedStyle(x).animationName,
      ),
      wires: [...document.querySelectorAll('.wire-track')].map((path) => {
        const [branch, segment] = path.parentElement.dataset.wire.split('-');
        const mobile = branch === 'wifi';
        const startAnchor = mobile
          ? 'source-wifi'
          : segment === 'source'
            ? `source-${branch}`
            : `sfu-${branch}`;
        const endAnchor = mobile
          ? 'sfu-input'
          : segment === 'source'
            ? `sfu-${branch}`
            : `leaf-${branch}`;
        const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
        const end = path
          .getPointAtLength(path.getTotalLength())
          .matrixTransform(path.getScreenCTM());
        const source = document
          .querySelector(`[data-anchor="${startAnchor}"]`)
          .getBoundingClientRect();
        const target = document
          .querySelector(`[data-anchor="${endAnchor}"]`)
          .getBoundingClientRect();
        return {
          branch,
          segment,
          startDistance: Math.hypot(
            start.x - source.right,
            start.y - (source.top + source.height / 2),
          ),
          endDistance: Math.hypot(
            end.x - (mobile ? target.left + target.width / 2 : target.left),
            end.y - (mobile ? target.top : target.top + target.height / 2),
          ),
        };
      }),
    }));
    assert.equal(metrics.overflow, false);
    assert.ok(metrics.motion.every((x) => x === 'none'));
    assert.equal(metrics.wires.length, width >= 1024 ? 6 : 1);
    assert.ok(metrics.wires.every((wire) => wire.startDistance < 0.75 && wire.endDistance < 0.75));
    assert.equal(
      metrics.wires.filter((wire) => wire.branch === 'robot').length,
      width >= 1024 ? 2 : 0,
    );
    result.viewports.push({ width, overflow: metrics.overflow, wiresAligned: true });
    await page.getByRole('button', { name: 'Close signal explanation' }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press('Control+Home');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      'Skip to the exhibit',
    );
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#exhibit');
    result.keyboard = true;
    if (width === 390)
      await page.screenshot({ path: '../artifacts/worker/mobile-offline.png', fullPage: true });
  }
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = error.message;
  process.exitCode = 1;
} finally {
  result.errors = errors;
  await fs.writeFile(
    '../artifacts/worker/layout-result.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
  for (const c of contexts) await c.close();
  await browser.close();
}
