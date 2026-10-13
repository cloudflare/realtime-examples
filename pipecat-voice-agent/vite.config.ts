import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { backendOrigin, liveProxy } from './scripts/dev-proxy.ts';

export default defineConfig(({ command, mode, isPreview }) => {
  const uiPreview = command === 'serve' && !isPreview && mode === 'ui';
  const env = loadEnv(mode, process.cwd(), 'VOICE_');
  const proxy =
    command === 'serve' && mode === 'live'
      ? { '/api/': liveProxy(backendOrigin(env.VOICE_BACKEND_URL)) }
      : undefined;
  return {
    root: 'web',
    plugins: [react(), tailwindcss()],
    define: { __VOICE_PREVIEW__: JSON.stringify(uiPreview) },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      license: { fileName: 'LICENSES.md' },
      rolldownOptions: {
        output: { postBanner: '/*! Licenses: /NOTICE.txt and /LICENSES.md */' },
      },
    },
    server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, cors: false, proxy },
  };
});
