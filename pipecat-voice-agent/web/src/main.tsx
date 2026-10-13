import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Vite replaces this constant at build time. Preview fixtures and controls are
// only imported by the UI dev server and are absent from deployment bundles.
async function mount() {
  const { default: App } = __VOICE_PREVIEW__
    ? await import('./preview/PreviewApp')
    : await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void mount();
