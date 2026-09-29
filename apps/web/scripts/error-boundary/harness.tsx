import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ErrorBoundary, { SectionErrorBoundary } from '../../src/components/ErrorBoundary';

/**
 * A test-only page for the error boundaries — never part of the app build.
 *
 * It mounts the real ErrorBoundary.tsx inside a stand-in shell (a nav that
 * must survive) and gives the verifier buttons to make one page throw: a
 * render bug, a failure that clears once its cause does (so Retry can
 * recover), and a
 * lost lazy chunk (which must reach the root boundary instead).
 */
type Mode = 'ok' | 'bug' | 'once' | 'chunk';

function Page({ mode }: { mode: Mode }) {
  if (mode === 'bug') throw new TypeError("Cannot read properties of undefined (reading 'id')");
  // Fails until the verifier clears the cause (window.__broken = false), the
  // way a flaky dependency recovers; React's own single re-render would
  // otherwise hide a failure that happens only once.
  if (mode === 'once' && (globalThis as { __broken?: boolean }).__broken !== false)
    throw new Error('transient render failure');
  if (mode === 'chunk')
    throw new TypeError('Failed to fetch dynamically imported module: /assets/Page-abc123.js');
  return <p data-testid="page">page content</p>;
}

function Shell() {
  const [route, setRoute] = useState('/a');
  const [mode, setMode] = useState<Mode>('ok');
  return (
    <div>
      <nav data-testid="nav">
        <button data-testid="go-b" onClick={() => setRoute((r) => (r === '/a' ? '/b' : '/a'))}>
          navigate
        </button>
        <button data-testid="bug" onClick={() => setMode('bug')}>
          bug
        </button>
        <button data-testid="once" onClick={() => setMode('once')}>
          once
        </button>
        <button data-testid="chunk" onClick={() => setMode('chunk')}>
          chunk
        </button>
        <button data-testid="fix" onClick={() => setMode('ok')}>
          fix
        </button>
        <span data-testid="route">{route}</span>
      </nav>
      <main>
        <SectionErrorBoundary resetKey={route}>
          <Page mode={mode} />
        </SectionErrorBoundary>
      </main>
    </div>
  );
}

// No reload during the test: the root's chunk recovery is observed, not run.
try {
  sessionStorage.setItem('chunk-reloaded', '1');
} catch {
  /* storage blocked: the root shows its fallback either way */
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Shell />
  </ErrorBoundary>,
);
