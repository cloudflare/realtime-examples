import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { liveBackend } from './dev/live-backend.ts';
import { developmentHosts } from './dev/hosts.ts';
import { aliases } from './dev/aliases.ts';

export default defineConfig(({ mode }) => {
  execFileSync(
    process.env.PYTHON ?? 'python3',
    [
      fileURLToPath(new URL('../scripts/prepare_secrets.py', import.meta.url)),
      '--sync',
      '--if-present',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const env = loadEnv(mode, process.cwd(), '');
  const allowedHosts = developmentHosts(env.RADIO_DEV_HOSTS);
  return {
    resolve: { alias: aliases },
    plugins: [
      liveBackend(env.RADIO_API_ORIGIN, allowedHosts),
      react(),
      tailwindcss(),
      cloudflare({ inspectorPort: false, remoteBindings: false }),
    ],
    server: { host: '0.0.0.0', port: 11880, strictPort: true, allowedHosts },
    preview: { host: '0.0.0.0', port: 11880, strictPort: true, allowedHosts },
  };
});
