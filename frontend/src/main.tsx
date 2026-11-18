import './i18n';
import { createRoot } from 'react-dom/client';
import { router } from './router';
import { RouterProvider } from '@tanstack/react-router';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { startCloudflareSessionWatch } from './lib/cloudflareSession';
import { hydrateExternalBackgrounds } from './components/background';

startCloudflareSessionWatch();

// Register cached external backgrounds before the first render so a stored
// selection resolves without a fallback flash; AppShell revalidates after mount.
hydrateExternalBackgrounds();

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);

// PWA: cache the hashed build output, nothing else (see public/sw.js). Skipped in
// dev, where Vite serves unhashed modules that a cache-first worker would pin.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A worker is an optimisation; the app works without one.
    });
  });
}
