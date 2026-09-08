import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./tests/workerd/wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["tests/workerd/**/*.test.ts"],
    setupFiles: ["./tests/workerd/setup.ts"],
  },
});
