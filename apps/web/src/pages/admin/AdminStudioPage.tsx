import { useTranslation } from 'react-i18next';
import { egp } from '../../lib/format';
import { ADMIN_THEME_PRESETS, applyAdminTheme, resetAdminTheme } from '../../lib/adminTheme';
import { useAdminThemePreference, useSetAdminTheme } from '../../lib/adminStudio';
import { Badge, BarChart, PageHeader, ProgressBar, Skeleton } from '../../components/ui';

function rgb(tokens: string) {
  return `rgb(${tokens})`;
}

/** One preset card — swatches drawn from the preset's OWN token values, not
 *  the live `--c-*` variables, so the gallery shows every theme correctly
 *  regardless of which one (if any) is currently applied. */
function ThemeCard({
  theme,
  active,
  onPreview,
  onApply,
}: {
  theme: (typeof ADMIN_THEME_PRESETS)[number];
  active: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`card cursor-pointer p-4 transition ${active ? 'ring-2 ring-primary' : ''}`}
      style={{ backgroundColor: rgb(theme.tokens.surface), borderColor: rgb(theme.tokens.border) }}
      onClick={onPreview}
    >
      <div className="mb-3 flex h-16 overflow-hidden rounded-xl" style={{ backgroundColor: rgb(theme.tokens.background) }}>
        <div className="w-6" style={{ backgroundColor: rgb(theme.tokens.sidebar) }} />
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          <div className="h-2 w-10 rounded-full" style={{ backgroundColor: rgb(theme.tokens.topbar) }} />
          <div className="flex gap-1.5">
            <div className="h-6 flex-1 rounded-md" style={{ backgroundColor: rgb(theme.tokens.surfaceElevated) }} />
            <div className="h-6 w-6 rounded-md" style={{ backgroundColor: rgb(theme.tokens.primary) }} />
          </div>
        </div>
      </div>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-heading text-sm font-bold" style={{ color: rgb(theme.tokens.text) }}>{theme.name}</p>
        {active && <span className="material-symbols-outlined text-base text-primary">check_circle</span>}
      </div>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-4 w-4 rounded-full" style={{ backgroundColor: rgb(theme.tokens.primary) }} />
        <span className="h-4 w-4 rounded-full" style={{ backgroundColor: rgb(theme.tokens.accent) }} />
        <span className="text-xs" style={{ color: rgb(theme.tokens.textMuted) }}>{theme.mode === 'dark' ? t('adminControlStudio.theme.dark') : t('adminControlStudio.theme.light')}</span>
      </div>
      <button
        className="btn-primary w-full py-1.5 text-xs"
        onClick={(e) => { e.stopPropagation(); onApply(); }}
      >
        {t('adminControlStudio.theme.apply')}
      </button>
    </div>
  );
}

/** The rest of the page IS the live preview: every element below reads the
 *  same live `--c-*` tokens (via the [data-admin-theme] remap) the whole
 *  Admin Studio already renders with — previewing a theme by applying it
 *  temporarily means this section, the sidebar, and every other admin page
 *  all repaint together, which is the strongest proof the token system
 *  really is shared. */
function LivePreviewPanel() {
  const { t } = useTranslation();
  return (
    <div className="card space-y-6 p-5">
      <h3 className="font-heading text-lg font-bold">{t('adminControlStudio.theme.livePreview')}</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="font-heading text-2xl font-extrabold tabular-nums">{egp(482_000)}</p>
          <p className="text-xs text-on-surface-variant">{t('adminControlStudio.theme.previewKpi1')}</p>
        </div>
        <div className="card p-4">
          <p className="font-heading text-2xl font-extrabold tabular-nums">128</p>
          <p className="text-xs text-on-surface-variant">{t('adminControlStudio.theme.previewKpi2')}</p>
        </div>
        <div className="card p-4">
          <Badge tone="primary">{t('adminControlStudio.theme.previewBadgeActive')}</Badge>
          <Badge tone="warn">{t('adminControlStudio.theme.previewBadgeWarn')}</Badge>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-on-surface-variant">{t('adminControlStudio.theme.previewChart')}</p>
        <BarChart data={[{ label: 'S', value: 4 }, { label: 'M', value: 7 }, { label: 'T', value: 5 }, { label: 'W', value: 9 }, { label: 'T', value: 6 }]} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-bold text-on-surface-variant">{t('adminControlStudio.theme.previewTable')}</p>
          <div className="overflow-x-auto rounded-xl border border-outline-variant/40">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-outline-variant/40 text-on-surface-variant"><th className="p-2 text-start">{t('adminControlStudio.theme.previewName')}</th><th className="p-2 text-start">{t('adminControlStudio.theme.previewStatus')}</th></tr></thead>
              <tbody>
                <tr className="border-b border-outline-variant/30"><td className="p-2">Academy A</td><td className="p-2"><Badge tone="primary">{t('adminControlStudio.theme.previewBadgeActive')}</Badge></td></tr>
                <tr><td className="p-2">Academy B</td><td className="p-2"><Badge tone="neutral">{t('adminControlStudio.theme.previewPending')}</Badge></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-bold text-on-surface-variant">{t('adminControlStudio.theme.previewForm')}</p>
          <input className="input w-full" placeholder={t('adminControlStudio.theme.previewInput') as string} readOnly />
          <ProgressBar pct={62} />
          <div className="flex gap-2">
            <button className="btn-primary px-4 py-1.5 text-sm">{t('common.save')}</button>
            <button className="btn-secondary px-4 py-1.5 text-sm">{t('common.cancel')}</button>
          </div>
        </div>
      </div>
      <Skeleton className="h-6 rounded-lg" />
    </div>
  );
}

export default function AdminStudioPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useAdminThemePreference(true);
  const setTheme = useSetAdminTheme();
  const activeId = data?.themeId ?? null;

  return (
    <div className="page">
      <PageHeader title={t('adminControlStudio.title')} subtitle={t('adminControlStudio.subtitle')} />

      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        <a href="/admin/academies" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">apartment</span>
          <span className="font-heading text-sm font-bold">{t('adminControlStudio.actions.academies')}</span>
        </a>
        <a href="/admin/security" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">gpp_maybe</span>
          <span className="font-heading text-sm font-bold">{t('adminControlStudio.actions.security')}</span>
        </a>
        <a href="/admin/payouts" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">payments</span>
          <span className="font-heading text-sm font-bold">{t('adminControlStudio.actions.payouts')}</span>
        </a>
      </section>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-heading text-xl font-extrabold">{t('adminControlStudio.theme.gallery')}</h2>
        <button className="btn-secondary px-4 py-1.5 text-sm" onClick={() => { resetAdminTheme(); setTheme.mutate(null); }}>
          {t('adminControlStudio.theme.reset')}
        </button>
      </div>
      {isLoading ? (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-2xl" />)}</div>
      ) : (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ADMIN_THEME_PRESETS.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              active={activeId === theme.id}
              onPreview={() => applyAdminTheme(theme)}
              onApply={() => { applyAdminTheme(theme); setTheme.mutate(theme.id); }}
            />
          ))}
        </div>
      )}
      <p className="mb-6 text-xs text-outline">{t('adminControlStudio.theme.hint')}</p>

      <LivePreviewPanel />
    </div>
  );
}
