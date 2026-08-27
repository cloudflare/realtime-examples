import { validateLocalLinks } from "./lib/links.mjs";

const repoRoot = process.cwd();
const errors = validateLocalLinks(repoRoot);

if (errors.length > 0) {
  console.error("Local link validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Validated local links in repository Markdown files.");
