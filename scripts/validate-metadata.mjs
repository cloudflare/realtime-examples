import { validateRepositoryMetadata } from "./lib/metadata.mjs";

const repoRoot = process.cwd();
const result = validateRepositoryMetadata(repoRoot);

if (result.errors.length > 0) {
  console.error("Metadata validation failed:");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated catalog and ${result.blueprints.length} blueprint metadata file(s).`,
);
