import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyColorMode,
  resolveMode,
  setColorMode,
  storedMode,
  watchSystemMode,
  type ResolvedMode,
} from '../lib/colorMode';
import { repaintStudioForMode } from '../lib/studio';
import { repaintForMode } from '../lib/theme';

/**
 * Sun and moon, one tap apart.
 *
 * Deliberately two states and not three. "System" is what someone gets by never
 * touching this, and it keeps working until they do — but a switch that cycles
 * light → dark → system reads as broken the first time it lands on the mode the
 * person did not pick, so choosing here means choosing.
 *
 * The icon shows where the tap goes, not where you are: a moon on a light page
 * is an offer of dark, which is the same grammar the published academy page
 * uses.
 */
export default function ColorModeToggle() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ResolvedMode>(() => resolveMode());

  useEffect(() => {
    // The boot script already painted; this only re-syncs React's copy, and
    // keeps following the device for anyone who has not chosen.
    setMode(applyColorMode(storedMode()));
    return watchSystemMode((m) => {
      setMode(m);
      repaintForMode();
      // The student's own accent has a light and a dark end too.
      repaintStudioForMode();
    });
  }, []);

  const next: ResolvedMode = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="grid h-10 w-10 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
      onClick={() => {
        setMode(setColorMode(next));
        // The attribute alone is not enough: an academy's colours are inline
        // properties and beat the stylesheet, so the other end has to be
        // written over them.
        repaintForMode();
      // The student's own accent has a light and a dark end too.
      repaintStudioForMode();
      }}
      title={t(`colorMode.${next}`)}
      aria-label={t(`colorMode.${next}`)}
    >
      <span className="material-symbols-outlined">{mode === 'dark' ? 'light_mode' : 'dark_mode'}</span>
    </button>
  );
}
