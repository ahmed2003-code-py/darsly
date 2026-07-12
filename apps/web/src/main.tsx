import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { domAnimation, LazyMotion } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Lean Framer Motion: only the DOM-animation feature set is bundled (strict
          forbids the heavy `motion.*` API — we use `m.*` everywhere). */}
      <LazyMotion features={domAnimation} strict>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </LazyMotion>
    </QueryClientProvider>
  </StrictMode>,
);

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
