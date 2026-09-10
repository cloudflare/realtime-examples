import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("dist");
let removed = 0;

await removePreviewSecrets(outputDirectory);
console.log(
  `Removed ${removed} local preview secret file(s) from build output.`,
);

async function removePreviewSecrets(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removePreviewSecrets(target);
    } else if (
      entry.name === ".dev.vars" ||
      entry.name.startsWith(".dev.vars.")
    ) {
      await rm(target);
      removed += 1;
    }
  }
}
