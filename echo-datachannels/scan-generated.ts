import { readFile } from "node:fs/promises";

const bundleUrl = new URL("./dist/app.js", import.meta.url);
const bundle = await readFile(bundleUrl, "utf8");

const forbiddenPatterns = [
  ["SFU app ID environment variable", /REALTIME_SFU_APP_ID/],
  ["SFU bearer-token environment variable", /REALTIME_SFU_BEARER_TOKEN/],
  ["authorization header", /Authorization\s*[:=]/i],
  ["bearer credential", /Bearer\s+[A-Za-z0-9._~-]+/i],
  ["direct Realtime SFU endpoint", /rtc\.live\.cloudflare\.com/i],
] as const;

for (const [label, pattern] of forbiddenPatterns) {
  if (pattern.test(bundle)) {
    throw new Error(`Generated browser bundle contains ${label}.`);
  }
}

console.log("Generated browser asset scan passed: dist/app.js");
