import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { entryScriptOf, isStale, runningEntry } from '../lib/buildFreshness';

const RELOADED_FOR = 'build-reloaded-for';
const CHECK_EVERY_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;

/*
 * Mounted once inside the router. Production only: the dev server has no
 * hashed entry script and reloads itself.
 */
function useBuildFreshness(): void {
  const { pathname, search, hash } = useLocation();
  const stale = useRef(false);
  const first = useRef(true);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const running = runningEntry();
    if (!running) return;
    let lastCheck = 0;
    const check = async () => {
      if (stale.current || Date.now() - lastCheck < MIN_GAP_MS) return;
      lastCheck = Date.now();
      try {
        const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const served = entryScriptOf(await res.text());
        // One reload per new build: if a reload already went for this build and
        // the page still runs another (a proxy serving an old copy), stop here
        // rather than loop.
        if (isStale(running, served) && sessionStorage.getItem(RELOADED_FOR) !== served) {
          stale.current = true;
          sessionStorage.setItem(RELOADED_FOR, served!);
        }
      } catch {
        /* offline or blocked: keep the running build */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (stale.current) window.location.assign(pathname + search + hash);
  }, [pathname, search, hash]);
}

/**
 * Moves a tab that outlived a deploy onto the new build on its next in-app
 * navigation (see lib/buildFreshness.ts). Renders nothing.
 */
export default function BuildFreshness(): null {
  useBuildFreshness();
  return null;
}
