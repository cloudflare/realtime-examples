import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        durableObjects: {
          GAME_CONTAINER: {
            className: "GameContainer",
            container: {
              imageName: "docker.io/library/alpine:3.22",
            },
            useSQLite: true,
          },
        },
      },
      wrangler: {
        configPath: "./scripts/workerd-wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["src/server/**/*.workerd.test.ts"],
  },
});
