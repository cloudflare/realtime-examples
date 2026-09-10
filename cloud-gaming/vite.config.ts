import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  build: {
    sourcemap: false,
  },
  plugins: [
    react(),
    tailwindcss(),
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
