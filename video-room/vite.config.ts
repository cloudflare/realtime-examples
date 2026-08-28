import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  build: {
    sourcemap: false,
  },
  plugins: [
    cloudflare({
      config:
        command === "serve" && !isPreview
          ? (workerConfig) => ({
              vars: {
                ...workerConfig.vars,
                AUTH_MODE: "local",
              },
            })
          : undefined,
    }),
  ],
  server: {
    port: 8787,
    strictPort: true,
  },
}));
