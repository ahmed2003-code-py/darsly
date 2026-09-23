import { useTranslation } from 'react-i18next';
import type { AdminThemeEntry, AdminThemeTokens } from '@darsly/shared-types';
import { Badge } from './ui';

/**
 * The same miniature console the Admin Studio paints, reused wherever a look
 * has to be chosen rather than worn. Drawn from the entry's own tokens so a
 * card is right whichever palette the live page is currently wearing.
 */

const rgb = (triple: string) => `rgb(${triple})`;

type Shelf = 'PRESET' | 'CENTER' | 'TEACHER' | 'COSMETIC';

function shelfOf(e: AdminThemeEntry): Shelf {
  if (e.source === 'PRESET') return 'PRESET';
  if (e.source === 'COSMETIC') return 'COSMETIC';
  return e.meta.academyKind === 'CENTER' ? 'CENTER' : 'TEACHER';
}

export function LookPreview({ tokens, tall }: { tokens: AdminThemeTokens; tall?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex w-full overflow-hidden rounded-xl ${tall ? 'h-40' : 'h-24'}`}
      style={{ backgroundColor: rgb(tokens.background), border: `1px solid ${rgb(tokens.border)}` }}
    >
      <span
        className="flex w-1/5 flex-col gap-1.5 p-2"
        style={{ backgroundColor: rgb(tokens.sidebar) }}
      >
        <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: rgb(tokens.primary) }} />
        <span
          className="h-1 w-full rounded-full"
          style={{ backgroundColor: rgb(tokens.textMuted), opacity: 0.5 }}
        />
        <span
          className="h-1 w-3/4 rounded-full"
          style={{ backgroundColor: rgb(tokens.textMuted), opacity: 0.35 }}
        />
      </span>
      <span className="flex flex-1 flex-col">
        <span
          className="flex h-4 items-center gap-1 px-2"
          style={{ backgroundColor: rgb(tokens.topbar) }}
        >
          <span
            className="h-1 w-8 rounded-full"
            style={{ backgroundColor: rgb(tokens.text), opacity: 0.6 }}
          />
          <span
            className="ms-auto h-2 w-2 rounded-full"
            style={{ backgroundColor: rgb(tokens.accent) }}
          />
        </span>
        <span className="flex flex-1 items-end gap-1 p-2">
          <span className="h-3 w-6 rounded-md" style={{ backgroundColor: rgb(tokens.primary) }} />
          <span
            className="h-3 w-6 rounded-md"
            style={{
              backgroundColor: rgb(tokens.surfaceElevated),
              border: `1px solid ${rgb(tokens.border)}`,
            }}
          />
        </span>
      </span>
    </span>
  );
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
            <LookPreview tokens={entry.tokens} />
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
            <LookPreview tokens={entry.tokens} />
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
