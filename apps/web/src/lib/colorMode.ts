/**
 * Light or dark, chosen by the person reading.
 *
 * One switch for the whole platform. A visitor who turns an academy's public
 * page dark and then signs in should not be handed a white console — the
 * published page and the app read and write the same key, so the choice
 * follows them across the door.
 *
 * `data-theme` on the root element belongs to this module and nothing else.
 * The academy palette writes colours; this writes which end of them to wear.
 * Two owners for one attribute is how a page ends up light with dark text.
 */

export type ColorMode = 'light' | 'dark' | 'system';
export type ResolvedMode = 'light' | 'dark';

/** Shared with the published academy page, which writes the same values. */
export const COLOR_MODE_KEY = 'darsly-color-mode';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** What the person asked for, which may be "whatever this device says". */
export function storedMode(): ColorMode {
  try {
    const raw = localStorage.getItem(COLOR_MODE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : 'system';
  } catch {
    // A blocked or full storage costs the preference, not the page.
    return 'system';
  }
}

export function resolveMode(mode: ColorMode = storedMode()): ResolvedMode {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}

/**
 * Paint it.
 *
 * `data-theme` is set for both ends rather than only for dark: an academy's
 * own palette may be dark by design, and without an explicit `light` there is
 * no way for a reader to ask for the light end of it.
 */
export function applyColorMode(mode: ColorMode = storedMode()): ResolvedMode {
  const resolved = resolveMode(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

export function setColorMode(mode: ColorMode): ResolvedMode {
  try {
    if (mode === 'system') localStorage.removeItem(COLOR_MODE_KEY);
    else localStorage.setItem(COLOR_MODE_KEY, mode);
  } catch {
    // Not persisted, still applied — this tab honours the click either way.
  }
  return applyColorMode(mode);
}

/**
 * Follow the device while the person has not overridden it.
 *
 * Returns an unsubscribe. Only fires while the stored preference is `system`,
 * so someone who has explicitly chosen light does not get flipped at sunset by
 * an OS schedule.
 */
export function watchSystemMode(onChange: (resolved: ResolvedMode) => void): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  const handler = () => {
    if (storedMode() !== 'system') return;
    onChange(applyColorMode('system'));
  };
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

/**
 * Apply the stored mode before React mounts.
 *
 * From the module top level, not an effect: by the time a component has
 * rendered, a dark-mode reader has already been shown a white page.
 */
export function bootColorMode(): ResolvedMode {
  return applyColorMode();
}
