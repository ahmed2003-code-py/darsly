import { useTranslation } from 'react-i18next';
import type { AdminThemeEntry } from '@darsly/shared-types';
import { EntryMiniature } from './ThemeMiniature';
import { Badge } from './ui';

/**
 * The grids a look is chosen from rather than worn in. Each card is the same
 * miniature the student's Studio draws (`EntryMiniature`), so a Center is
 * granted — and applies — exactly the theme a student would see.
 */

type Shelf = 'PRESET' | 'CENTER' | 'TEACHER' | 'COSMETIC';

function shelfOf(e: AdminThemeEntry): Shelf {
  if (e.source === 'PRESET') return 'PRESET';
  if (e.source === 'COSMETIC') return 'COSMETIC';
  return e.meta.academyKind === 'CENTER' ? 'CENTER' : 'TEACHER';
}

function Meta({ entry }: { entry: AdminThemeEntry }) {
  const { t } = useTranslation();
  const shelf = shelfOf(entry);
  return (
    <div className="mt-2 min-w-0">
      <p className="truncate font-heading text-sm font-bold">{entry.name}</p>
      <p className="truncate text-xs text-on-surface-variant">
        {entry.subtitle ?? t(`adminControlStudio.shelf.${shelf}`)}
      </p>
    </div>
  );
}

/** Admin granting: every look on the platform, ticked or not. */
export function ThemeGrantGrid({
  themes,
  selected,
  onToggle,
}: {
  themes: AdminThemeEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {themes.map((entry) => {
        const checked = selected.has(entry.id);
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onToggle(entry.id)}
            className={`card flex flex-col p-3 text-start transition ${checked ? 'ring-2 ring-primary' : ''}`}
            aria-pressed={checked}
          >
            <EntryMiniature entry={entry} />
            <div className="mt-2 flex items-start gap-2">
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border-2 ${
                  checked ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant'
                }`}
              >
                {checked && <span className="material-symbols-outlined text-sm">check</span>}
              </span>
              <Meta entry={entry} />
            </div>
            <p className="mt-1 text-xs text-outline">
              {checked ? t('centerStudio.granted') : t('centerStudio.notGranted')}
            </p>
          </button>
        );
      })}
    </div>
  );
}

/** Center owner choosing: only the looks they were given, one of which they wear. */
export function ThemeApplyGrid({
  themes,
  appliedId,
  onApply,
  busy,
}: {
  themes: AdminThemeEntry[];
  appliedId: string | null;
  onApply: (id: string) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {themes.map((entry) => {
        const active = appliedId === entry.id;
        return (
          <article
            key={entry.id}
            className={`card flex flex-col p-3 ${active ? 'ring-2 ring-primary' : ''}`}
          >
            <EntryMiniature entry={entry} />
            <div className="mt-2 flex items-start justify-between gap-2">
              <Meta entry={entry} />
              {active && <Badge tone="primary">{t('centerStudio.wearing')}</Badge>}
            </div>
            {!active && (
              <button
                type="button"
                className="btn-primary mt-3 px-4 py-2 text-sm"
                disabled={busy}
                onClick={() => onApply(entry.id)}
              >
                {t('centerStudio.apply')}
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
