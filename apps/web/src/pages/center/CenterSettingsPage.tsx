import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Link } from 'react-router-dom';
import { useOwnedAcademy } from '../../lib/academy';
import { BrandingTab } from '../academy/AcademyConsolePage';
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '../../components/ui';

/**
 * Center profile: the existing academy settings form (name, tagline, logo,
 * cover, slug, colours) plus, Phase 7, the Center's default revenue share
 * with its teachers. Kind and status are not in that form — they belong to
 * the platform admin.
 */
export default function CenterSettingsPage() {
  const { t } = useTranslation();
  const { academy, isLoading } = useOwnedAcademy();
  if (isLoading)
    return (
      <div className="page">
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  if (!academy)
    return (
      <div className="page">
        <EmptyState icon="apartment" title={t('center.noCenter')} />
      </div>
    );
  return (
    <div className="page">
      <PageHeader title={t('center.settings')} subtitle={academy.name} />
      {academy.kind === 'CENTER' && (
        <Link to="/center/studio" className="card card-hover mb-6 flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-2xl text-primary">palette</span>
          <div>
            <p className="font-heading font-bold">{t('centerStudio.title')}</p>
            <p className="text-sm text-on-surface-variant">{t('centerStudio.tileSub')}</p>
          </div>
        </Link>
      )}
      <RevenueShareCard slug={academy.slug} />
      <BrandingTab slug={academy.slug} />
    </div>
  );
}

/**
 * A paid Center course cannot be sold until this is set (no default
 * percentage is ever assumed) — see revenue-split.ts on the API.
 */
function RevenueShareCard({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['academy-settings', slug],
    queryFn: async () => (await api.get(`/academies/${slug}/settings`)).data,
  });
  const [pct, setPct] = useState('');
  useEffect(() => {
    if (data) setPct(data.teacherSharePercent == null ? '' : String(data.teacherSharePercent));
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      (
        await api.patch(`/academies/${slug}/settings`, {
          teacherSharePercent: pct === '' ? null : Math.max(0, Math.min(100, Number(pct))),
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['academy-settings', slug] }),
  });

  if (!data || data.kind !== 'CENTER') return null;
  return (
    <div className="card mb-6">
      <h2 className="mb-1 font-heading text-lg font-bold">{t('center.revenueShare.title')}</h2>
      <p className="mb-4 text-sm text-on-surface-variant">{t('center.revenueShare.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold text-on-surface-variant">
            {t('center.revenueShare.label')}
          </span>
          <div className="flex items-center gap-2">
            <input
              className="input w-28"
              inputMode="numeric"
              placeholder="—"
              value={pct}
              onChange={(e) => setPct(e.target.value.replace(/[^\d]/g, ''))}
            />
            <span className="text-on-surface-variant">%</span>
          </div>
        </label>
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
      {pct === '' && (
        <p className="mt-3 rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container">
          {t('center.revenueShare.unsetWarning')}
        </p>
      )}
      <ErrorNote error={save.error} />
      <p className="mt-3 text-xs text-outline">{t('center.revenueShare.overrideHint')}</p>
    </div>
  );
}
