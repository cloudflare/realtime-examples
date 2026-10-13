import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/client/**/*.test.ts'], environment: 'node' },
});
