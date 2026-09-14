import { fileURLToPath } from 'node:url';

// Keep these roots aligned with tsconfig.paths.json.
export const aliases = {
  '@': fileURLToPath(new URL('../src', import.meta.url)),
  '@dev': fileURLToPath(new URL('.', import.meta.url)),
  '@tests': fileURLToPath(new URL('../tests', import.meta.url)),
};
