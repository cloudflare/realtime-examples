import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const indexUrl = new URL("../index.html", import.meta.url);
const appUrl = new URL("../app.ts", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const stylesUrl = new URL("../styles.css", import.meta.url);

test("UI presents one compact ACK-gate workflow", async () => {
  const [html, readme, styles] = await Promise.all([
    fs.readFile(indexUrl, "utf8"),
    fs.readFile(readmeUrl, "utf8"),
    fs.readFile(stylesUrl, "utf8"),
  ]);

  const controls = [
    'id="connect-button"',
    'id="send-probe"',
    'id="send-ack"',
    'id="send-reliable"',
    'id="send-reply"',
    'id="teardown-button"',
  ];
  for (const control of controls) {
    assert.ok(html.includes(control), `${control} is present`);
  }

  assert.match(html, /Realtime SFU DataChannels/);
  assert.match(html, /Send disposable probe/);
  assert.match(html, /Send subscriber ACK/);
  assert.match(html, /readiness gate, not a durable queue/);
  assert.match(html, /may retain bounded early traffic/);
  assert.match(html, /Send the ACK before traffic\s+that must be delivered/);
  assert.match(html, /Exact API and browser settings/);
  assert.doesNotMatch(
    `${html}\n${styles}`,
    /data-journey-step|Open the gate, then|Run order|Iowan Old Style|background-image/,
  );
  assert.doesNotMatch(`${html}\n${readme}`, /\b64\b/);
});

test("browser controls separate disposable pre-ACK traffic from delivery proof", async () => {
  const app = await fs.readFile(appUrl, "utf8");

  assert.match(app, /type: "disposable-probe"/);
  assert.match(
    app,
    /connected && acknowledgmentSent && !acknowledgmentExpired/,
  );
  assert.match(app, /postAckMessageDelivered/);
  assert.match(
    app,
    /bounded early retention observed; do not rely on replay/,
  );
  assert.match(app, /setTimeout\(expireAcknowledgment, remainingMs\)/);
  assert.doesNotMatch(app, /setInterval\(/);
  assert.doesNotMatch(app, /setJourneyStep|resetJourney/);
});
