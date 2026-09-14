import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
await fs.mkdir('../artifacts/worker', { recursive: true });
const browser = await chromium.connectOverCDP(
  process.env.RADIO_CDP_URL ?? 'http://127.0.0.1:19223',
);
const contexts = [],
  result = { cases: [] },
  errors = [];
try {
  for (const width of [320, 390, 1380]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      reducedMotion: 'reduce',
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    contexts.push(context);
    await context.route('**/api/status', (route) =>
      route.fulfill({ json: { online: false, viewers: 0, controller: null, generation: null } }),
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(process.env.RADIO_TEST_URL ?? 'http://localhost:11880');
    for (const selector of [
      '[aria-labelledby="board-title"] button',
      '[aria-label="Cloudflare Realtime SFU relay"] button',
      '[data-anchor="leaf-audio"] button[aria-haspopup]',
      '[data-anchor="leaf-spectrum"] button[aria-haspopup]',
      '[data-anchor="leaf-robot"] button[aria-haspopup]',
    ]) {
      const trigger = page.locator(selector).first();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const popup = page.getByRole('dialog');
      await popup.waitFor();
      await page.waitForTimeout(100);
      const box = await popup.boundingBox();
      assert.ok(
        box.x >= 10 && box.y >= 10 && box.x + box.width <= width - 10 && box.y + box.height <= 846,
        JSON.stringify({ width, selector, box }),
      );
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      if (selector.includes('leaf-spectrum'))
        await page.screenshot({ path: `../artifacts/worker/popover-${width}.png` });
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      await trigger.click();
      await popup.waitFor();
      await page.mouse.click(3, 3);
      await popup.waitFor({ state: 'detached' });
      result.cases.push({
        width,
        selector,
        contained: true,
        escape: true,
        focusRestored: true,
        outsideDismiss: true,
      });
    }
    if (width === 1380) assert.equal(await page.locator('.wire-robot .wire-track').count(), 2);
    assert.equal(await page.getByText('REAL HARDWARE. REAL SIGNALS.', { exact: true }).count(), 0);
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
    '../artifacts/worker/popovers-result.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
  for (const c of contexts) await c.close();
  await browser.close();
}
