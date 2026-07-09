import { useEffect, useRef, useState } from 'react';

/**
 * Client-side hardening for the secure player. HONEST SCOPE: none of this
 * prevents a determined attacker (a second camera defeats everything). It
 * raises the effort bar and, more importantly, feeds forensic signals to the
 * server. Documented as DETERRENCE, not protection.
 */

export interface HardeningCallbacks {
  /** fired when devtools is detected open — pause + blur + report */
  onDevtools: () => void;
  /** fired on tab blur / visibility loss — pause + blur */
  onObscured: () => void;
  /** fired when focus/visibility returns */
  onRevealed: () => void;
}

/** Block context menu, selection, drag, and common save/print shortcuts. */
export function useNoCopyGuards(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const block = (e: Event) => e.preventDefault();
    const keyBlock = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // Save, print, view-source, and the devtools shortcuts.
      if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(k)) e.preventDefault();
      if (e.key === 'F12') e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(k)) e.preventDefault();
    };
    document.addEventListener('contextmenu', block);
    document.addEventListener('selectstart', block);
    document.addEventListener('dragstart', block);
    document.addEventListener('keydown', keyBlock);
    return () => {
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('selectstart', block);
      document.removeEventListener('dragstart', block);
      document.removeEventListener('keydown', keyBlock);
    };
  }, [enabled]);
}

/**
 * Pause + blur when the tab is hidden or loses focus (screen-share / recording
 * apps often trigger blur), and detect an open devtools panel via the
 * window-dimension gap heuristic.
 */
export function useObscureAndDevtools(enabled: boolean, cb: HardeningCallbacks) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const onVisibility = () => {
      if (document.hidden) cbRef.current.onObscured();
      else cbRef.current.onRevealed();
    };
    const onBlur = () => cbRef.current.onObscured();
    const onFocus = () => cbRef.current.onRevealed();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    // Devtools heuristic: a docked panel opens a large gap between the outer
    // and inner window dimensions. Not foolproof (undocked devtools evades it),
    // but a cheap deterrent + forensic signal.
    let flagged = false;
    const threshold = 170;
    const check = () => {
      const gap =
        window.outerWidth - window.innerWidth > threshold ||
        window.outerHeight - window.innerHeight > threshold;
      if (gap && !flagged) {
        flagged = true;
        setDevtoolsOpen(true);
        cbRef.current.onDevtools();
      } else if (!gap && flagged) {
        flagged = false;
        setDevtoolsOpen(false);
      }
    };
    const interval = window.setInterval(check, 1000);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [enabled]);

  return { devtoolsOpen };
}
