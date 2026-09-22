import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminThemeEntry } from '@darsly/shared-types';
import { ThemeGrantGrid } from '../../components/ThemeShelf';
import { useAdminThemeCatalog } from '../../lib/adminStudio';
import { useCenterThemeCatalog, useSetCenterThemeGrants } from '../../lib/centerStudio';
import { ErrorNote, Skeleton } from '../../components/ui';

/**
 * The checkboxes a platform admin ticks to decide which looks a Center may
 * wear. Used both on creation (no academy id yet — the catalogue is the
 * platform's, the selection travels in the create body) and on an existing
 * Center (the catalogue is the same shelf with this Center's grants marked,
 * and Save writes the list).
 */

type Shelf = 'ALL' | 'PRESET' | 'CENTER' | 'TEACHER' | 'COSMETIC';

function shelfOf(e: AdminThemeEntry): Exclude<Shelf, 'ALL'> {
  if (e.source === 'PRESET') return 'PRESET';
  if (e.source === 'COSMETIC') return 'COSMETIC';
  return e.meta.academyKind === 'CENTER' ? 'CENTER' : 'TEACHER';
}

export function CenterThemeGrantPicker({
  academyId,
  selected,
  onChange,
}: {
  /** When omitted, this is the create-Center form: local selection only. */
  academyId?: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [shelf, setShelf] = useState<Shelf>('ALL');
  const platform = useAdminThemeCatalog();
  const granted = useCenterThemeCatalog(academyId);

  const all = useMemo<AdminThemeEntry[]>(() => {
    if (granted.data) return granted.data.themes;
    if (!platform.data) return [];
    return [...platform.data.presets, ...platform.data.academies, ...platform.data.cosmetics];
  }, [granted.data, platform.data]);

  const shown = useMemo(
    () => all.filter((e) => shelf === 'ALL' || shelfOf(e) === shelf),
    [all, shelf],
  );

  const set = new Set(selected);
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const loading = academyId ? granted.isLoading : platform.isLoading;

  return (
    <div>
      <div className="mb-3">
        <h3 className="font-heading font-bold">{t('centerStudio.grantTitle')}</h3>
        <p className="text-sm text-on-surface-variant">{t('centerStudio.grantHint')}</p>
        <p className="mt-1 text-xs text-outline">{t('centerStudio.grantCount', { count: selected.length })}</p>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        {(['ALL', 'PRESET', 'CENTER', 'TEACHER', 'COSMETIC'] as Shelf[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setShelf(s)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              shelf === s ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant text-on-surface-variant'
            }`}
          >
            {t(`adminControlStudio.shelf.${s}`)}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : !shown.length ? (
        <p className="rounded-xl bg-surface-container-low p-4 text-sm text-on-surface-variant">{t('centerStudio.noLooks')}</p>
      ) : (
        <ThemeGrantGrid themes={shown} selected={set} onToggle={toggle} />
      )}
      <ErrorNote error={granted.error ?? platform.error} />
    </div>
  );
}

/** Existing Center: the picker plus a Save that writes the grant list. */
export function CenterThemeGrantEditor({ academyId }: { academyId: string }) {
  const { t } = useTranslation();
  const catalog = useCenterThemeCatalog(academyId);
  const save = useSetCenterThemeGrants(academyId);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (catalog.data) setSelected(catalog.data.granted);
  }, [catalog.data]);

  return (
    <div>
      <CenterThemeGrantPicker academyId={academyId} selected={selected} onChange={setSelected} />
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary px-5 py-2.5"
          disabled={save.isPending || catalog.isLoading}
          onClick={() => save.mutate(selected)}
        >
          {save.isPending ? t('common.saving') : save.isSuccess ? t('common.saved') : t('centerStudio.saveGrants')}
        </button>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}
