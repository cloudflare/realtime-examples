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

const files = await walk(clientBuildDirectory);
if (files.length === 0) {
  console.log("No browser build assets are present yet.");
  process.exit(0);
}

const findings = [];
for (const file of files) {
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

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}
