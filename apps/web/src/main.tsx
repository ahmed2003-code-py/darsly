import { QueryClientProvider } from '@tanstack/react-query';
import { domAnimation, LazyMotion } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initI18n } from './i18n';
import './index.css';
import { Role } from '@darsly/shared-types';
import AppToasts from './components/AppToasts';
import { ConfirmDialog } from './components/ConfirmDialog';
import { bootAdminTheme } from './lib/adminTheme';
import { bootColorMode } from './lib/colorMode';
import { bootStudio } from './lib/studio';
import { queryClient } from './lib/queryClient';
import { bootTheme } from './lib/theme';
import { useAuthStore } from './stores/auth';

// Replay the academy's colours before the first paint. Waiting for React and a
// query to resolve would show the platform indigo first and then swap it, which
// reads as the app loading someone else's brand.
// Which end of the palette first, then whose palette it is, then what the
// student made of it. In that order: the academy writes the tokens the app is
// built on, and the student's own layer sits on top and only ever touches its
// own namespace.
bootColorMode();
bootTheme();
bootStudio();
// SUPER_ADMIN-gated: a no-op for every Student/Teacher session, even one
// that happens to share a browser profile with an admin — see adminTheme.ts.
bootAdminTheme(useAuthStore.getState().user?.role === Role.SUPER_ADMIN);

/**
 * The reader's language is loaded before the first render.
 *
 * Locales are separate chunks now (see i18n/index.ts), so this is a real await
 * rather than a formality. Mounting first and letting the strings arrive a
 * tick later would paint one frame of raw translation keys — a worse trade
 * than the few milliseconds spent here, and a very visible one in Arabic.
 */
void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {/* Lean Framer Motion: only the DOM-animation feature set is bundled (strict
          forbids the heavy `motion.*` API — we use `m.*` everywhere). */}
        <LazyMotion features={domAnimation} strict>
          <BrowserRouter>
            <App />
            {/* At the root, not inside the app shell: a sign-in, an activation or
              a public academy page can fail too, and those render no shell. */}
            <AppToasts />
            {/* Beside the toasts for the same reason: a destructive action can be
              taken from a page that renders no app shell. */}
            <ConfirmDialog />
          </BrowserRouter>
        </LazyMotion>
      </QueryClientProvider>
    </StrictMode>,
  );
});

// If the app has been running stably, clear the one-shot chunk-reload guard so a
// future deploy can recover again (see components/ErrorBoundary.tsx).
setTimeout(() => sessionStorage.removeItem('chunk-reloaded'), 5000);

// Register the PWA service worker (production only; dev keeps HMR clean).
// The ?v=<build id> makes the SW re-install on every deploy and version its
// cache, so returning users never get stuck on a stale build.
declare const __BUILD_ID__: string;
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {});
  });
}
