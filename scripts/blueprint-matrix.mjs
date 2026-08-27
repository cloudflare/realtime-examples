import { validateRepositoryMetadata } from "./lib/metadata.mjs";
import { buildBlueprintMatrix } from "./lib/matrix.mjs";

const result = validateRepositoryMetadata(process.cwd());
if (result.errors.length > 0) {
  for (const error of result.errors) {
    console.error(error);
  }
  process.exit(1);
}

const include = buildBlueprintMatrix(result.blueprints);

const matrix = JSON.stringify({ include });
if (process.argv.includes("--github-output")) {
  console.log(`matrix=${matrix}`);
  console.log(`count=${include.length}`);
} else {
  console.log(matrix);
}
