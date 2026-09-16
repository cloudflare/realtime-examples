import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { aliases } from './dev/aliases.ts';

export default defineConfig({
  resolve: { alias: aliases },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          REALTIME_APP_ID: 'test-app',
          REALTIME_APP_TOKEN: 'example-sfu-token',
          DEVICE_TOKEN: 'test-device-token',
          VIEWER_PASSWORD: 'test-viewer-password',
          ROBOT_NAME: 'test-board',
        },
      },
    }),
  ],
  test: {
    include: ['tests/runtime/**/*.test.ts'],
    setupFiles: ['tests/runtime/setup.ts'],
    testTimeout: 40000,
    hookTimeout: 15000,
  },
});
