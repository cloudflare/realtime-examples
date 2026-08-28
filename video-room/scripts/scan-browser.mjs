import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const clientBuildDirectory = "dist/client";
const forbidden = [
  /REALTIME_SFU_BEARER_TOKEN/g,
  /REALTIME_SFU_APP_ID/g,
  /CF_ACCESS_AUD/g,
  /CF_ACCESS_TEAM_DOMAIN/g,
  /rtc\.live\.cloudflare\.com[\s\S]{0,200}\b(?:Authorization|Bearer)\b/g,
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}

const findings = [];
for (const file of await walk(clientBuildDirectory)) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(`${file}: ${pattern.source}`);
  }
}

if (findings.length > 0) {
  console.error("Browser credential scan failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}
console.log("Browser credential scan passed.");
