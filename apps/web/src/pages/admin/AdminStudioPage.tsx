import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { egp } from '../../lib/format';
import { applyAdminTheme, DEFAULT_ADMIN_THEME, type AdminThemeEntry } from '../../lib/adminTheme';
import {
  useAdminThemeCatalog,
  useAdminThemePreference,
  useSetAdminTheme,
} from '../../lib/adminStudio';
import {
  Badge,
  BarChart,
  EmptyState,
  PageHeader,
  ProgressBar,
  Skeleton,
} from '../../components/ui';

/**
 * The Admin Studio: every look the console can wear, in one shelf.
 *
 * Built the way the student Studio is built — a mini app per card, drawn from
 * the look's own colours, with Preview and Apply — but the shelf here is the
 * whole platform: the built-in presets, the brand of every Center and every
 * teacher, and every theme in the store. Each is resolved by the API into the
 * same tokens; this page never composes a colour, it only paints what it was
 * handed and sends back an id.
 */

type Shelf = 'ALL' | 'PRESET' | 'CENTER' | 'TEACHER' | 'COSMETIC';
const SHELVES: Shelf[] = ['ALL', 'PRESET', 'CENTER', 'TEACHER', 'COSMETIC'];

const RARITY_TONE: Record<string, string> = {
  COMMON: 'bg-surface-container-high text-on-surface-variant',
  RARE: 'bg-secondary-container text-on-secondary-container',
  EPIC: 'bg-primary-fixed text-on-primary-fixed-variant',
  LEGENDARY: 'bg-student-gold-soft text-student-gold-ink',
};

const rgb = (triple: string) => `rgb(${triple})`;

function shelfOf(e: AdminThemeEntry): Exclude<Shelf, 'ALL'> {
  if (e.source === 'PRESET') return 'PRESET';
  if (e.source === 'COSMETIC') return 'COSMETIC';
  return e.meta.academyKind === 'CENTER' ? 'CENTER' : 'TEACHER';
}

/**
 * The console in miniature, painted in the look's own tokens: sidebar, top
 * bar, a KPI card, a primary button, a chart. Drawn from the entry, never
 * from the live `--c-*` variables, so every card is right whichever look is
 * currently applied.
 */
function LookPreview({ tokens, tall }: { tokens: AdminThemeEntry['tokens']; tall?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative flex w-full overflow-hidden rounded-xl ${tall ? 'h-40' : 'h-28'}`}
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
        <span
          className="h-1 w-5/6 rounded-full"
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
        <span className="flex flex-1 flex-col gap-1.5 p-2">
          <span className="flex gap-1.5">
            <span
              className="flex flex-1 flex-col gap-1 rounded-md p-1.5"
              style={{
                backgroundColor: rgb(tokens.surface),
                border: `1px solid ${rgb(tokens.border)}`,
              }}
            >
              <span
                className="h-1.5 w-1/2 rounded-full"
                style={{ backgroundColor: rgb(tokens.text), opacity: 0.85 }}
              />
              <span
                className="h-1 w-1/3 rounded-full"
                style={{ backgroundColor: rgb(tokens.textMuted), opacity: 0.7 }}
              />
            </span>
            <span
              className="flex flex-1 flex-col gap-1 rounded-md p-1.5"
              style={{
                backgroundColor: rgb(tokens.surfaceElevated),
                border: `1px solid ${rgb(tokens.border)}`,
              }}
            >
              <span
                className="h-1.5 w-2/3 rounded-full"
                style={{ backgroundColor: rgb(tokens.text), opacity: 0.85 }}
              />
              <span
                className="h-1 w-1/4 rounded-full"
                style={{ backgroundColor: rgb(tokens.success) }}
              />
            </span>
          </span>
          <span className="mt-auto flex items-end gap-1">
            <span className="h-3 w-6 rounded-md" style={{ backgroundColor: rgb(tokens.primary) }} />
            <span
              className="h-3 w-6 rounded-md"
              style={{
                backgroundColor: rgb(tokens.surfaceElevated),
                border: `1px solid ${rgb(tokens.border)}`,
              }}
            />
            <span className="ms-auto flex items-end gap-0.5">
              {[5, 8, 4, 9, 6].map((h, i) => (
                <span
                  key={i}
                  className="w-1 rounded-t-sm"
                  style={{
                    height: h * 1.5,
                    backgroundColor: rgb([tokens.chart1, tokens.chart2, tokens.chart3][i % 3]),
                  }}
                />
              ))}
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

function LookCard({
  entry,
  active,
  previewing,
  busy,
  onPreview,
  onApply,
  t,
}: {
  entry: AdminThemeEntry;
  active: boolean;
  previewing: boolean;
  busy: boolean;
  onPreview: () => void;
  onApply: () => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const shelf = shelfOf(entry);
  return (
    <article
      className={`studio-card card flex flex-col p-4 transition ${active ? 'ring-2 ring-primary' : previewing ? 'ring-2 ring-outline' : ''}`}
    >
      <span
        className={entry.meta.rarity === 'LEGENDARY' ? 'studio-sheen block rounded-xl' : 'block'}
      >
        <LookPreview tokens={entry.tokens} />
      </span>
      <div className="mt-3 flex items-start gap-2">
        {entry.meta.logoUrl ? (
          <img
            src={entry.meta.logoUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
            style={{ backgroundColor: rgb(entry.tokens.primary) }}
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ color: rgb(entry.tokens.background) }}
            >
              {shelf === 'PRESET'
                ? 'palette'
                : shelf === 'COSMETIC'
                  ? 'storefront'
                  : shelf === 'CENTER'
                    ? 'apartment'
                    : 'school'}
            </span>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading font-bold">{entry.name}</p>
          <p className="truncate text-xs text-on-surface-variant">
            {entry.subtitle ?? t(`adminControlStudio.shelf.${shelf}`)}
          </p>
        </div>
        {entry.meta.rarity ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${RARITY_TONE[entry.meta.rarity] ?? RARITY_TONE.COMMON}`}
          >
            {t(`myStudio.rarity.${entry.meta.rarity}`)}
          </span>
        ) : (
          <Badge tone="neutral">{t(`adminControlStudio.shelf.${shelf}`)}</Badge>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-on-surface-variant">
        <span
          className="h-3.5 w-3.5 rounded-full border border-outline-variant/40"
          style={{ backgroundColor: rgb(entry.tokens.primary) }}
        />
        <span
          className="h-3.5 w-3.5 rounded-full border border-outline-variant/40"
          style={{ backgroundColor: rgb(entry.tokens.accent) }}
        />
        <span
          className="h-3.5 w-3.5 rounded-full border border-outline-variant/40"
          style={{ backgroundColor: rgb(entry.tokens.background) }}
        />
        <span>
          {t(
            entry.mode === 'dark'
              ? 'adminControlStudio.theme.dark'
              : 'adminControlStudio.theme.light',
          )}
        </span>
        {entry.meta.slug && (
          <span className="ms-auto truncate" dir="ltr">
            /{shelf === 'CENTER' ? 'a' : 't'}/{entry.meta.slug}
          </span>
        )}
      </div>
      {active && (
        <p className="mt-2 flex items-center gap-1 text-sm font-bold text-primary">
          <span className="material-symbols-outlined text-[18px]">check_circle</span>
          {t('adminControlStudio.theme.current')}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2 pt-3">
        <button
          type="button"
          onClick={onPreview}
          className="rounded-xl border border-outline-variant px-3 py-2 text-sm font-bold transition hover:border-outline"
        >
          {previewing
            ? t('adminControlStudio.theme.stopPreview')
            : t('adminControlStudio.theme.preview')}
        </button>
        {!active && (
          <button
            type="button"
            disabled={busy}
            onClick={onApply}
            className="btn-primary ms-auto px-4 py-2 text-sm"
          >
            {t('adminControlStudio.theme.apply')}
          </button>
        )}
      </div>
    </article>
  );
}

/** The rest of the page IS the live preview: every element below reads the
 *  same live `--c-*` tokens (via the [data-admin-theme] remap) the whole
 *  Admin Studio renders with, so previewing a look repaints this section,
 *  the sidebar and every other admin page together. */
function LivePreviewPanel() {
  const { t } = useTranslation();
  return (
    <div className="card space-y-6 p-5">
      <h3 className="font-heading text-lg font-bold">
        {t('adminControlStudio.theme.livePreview')}
      </h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4">
          <p className="font-heading text-2xl font-extrabold tabular-nums">{egp(482_000)}</p>
          <p className="text-xs text-on-surface-variant">
            {t('adminControlStudio.theme.previewKpi1')}
          </p>
        </div>
        <div className="card p-4">
          <p className="font-heading text-2xl font-extrabold tabular-nums">128</p>
          <p className="text-xs text-on-surface-variant">
            {t('adminControlStudio.theme.previewKpi2')}
          </p>
        </div>
        <div className="card p-4">
          <Badge tone="primary">{t('adminControlStudio.theme.previewBadgeActive')}</Badge>
          <Badge tone="warn">{t('adminControlStudio.theme.previewBadgeWarn')}</Badge>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-on-surface-variant">
          {t('adminControlStudio.theme.previewChart')}
        </p>
        <BarChart
          data={[
            { label: 'S', value: 4 },
            { label: 'M', value: 7 },
            { label: 'T', value: 5 },
            { label: 'W', value: 9 },
            { label: 'T', value: 6 },
          ]}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-bold text-on-surface-variant">
            {t('adminControlStudio.theme.previewTable')}
          </p>
          <div className="overflow-x-auto rounded-xl border border-outline-variant/40">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant/40 text-on-surface-variant">
                  <th className="p-2 text-start">{t('adminControlStudio.theme.previewName')}</th>
                  <th className="p-2 text-start">{t('adminControlStudio.theme.previewStatus')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-outline-variant/30">
                  <td className="p-2">Academy A</td>
                  <td className="p-2">
                    <Badge tone="primary">{t('adminControlStudio.theme.previewBadgeActive')}</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="p-2">Academy B</td>
                  <td className="p-2">
                    <Badge tone="neutral">{t('adminControlStudio.theme.previewPending')}</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-bold text-on-surface-variant">
            {t('adminControlStudio.theme.previewForm')}
          </p>
          <input
            className="input w-full"
            placeholder={t('adminControlStudio.theme.previewInput') as string}
            readOnly
          />
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
  const pref = useAdminThemePreference(true);
  const catalog = useAdminThemeCatalog();
  const setTheme = useSetAdminTheme();
  const [shelf, setShelf] = useState<Shelf>('ALL');
  const [q, setQ] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const saved = pref.data?.theme ?? DEFAULT_ADMIN_THEME;
  const activeId = pref.data?.themeId ?? null;

  const all = useMemo<AdminThemeEntry[]>(
    () =>
      catalog.data
        ? [...catalog.data.presets, ...catalog.data.academies, ...catalog.data.cosmetics]
        : [],
    [catalog.data],
  );
  const counts = useMemo(() => {
    const c = new Map<Shelf, number>([['ALL', all.length]]);
    for (const e of all) c.set(shelfOf(e), (c.get(shelfOf(e)) ?? 0) + 1);
    return c;
  }, [all]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter(
      (e) =>
        (shelf === 'ALL' || shelfOf(e) === shelf) &&
        (!needle ||
          `${e.name} ${e.subtitle ?? ''} ${e.meta.slug ?? ''}`.toLowerCase().includes(needle)),
    );
  }, [all, shelf, q]);

  // A preview is a repaint, not a choice: leaving the page — or stopping the
  // preview — puts the saved look back exactly. Nothing is remembered in
  // storage until Apply, so a refresh mid-preview also lands on the saved look.
  const previewing = previewId ? (all.find((e) => e.id === previewId) ?? null) : null;
  useEffect(() => {
    applyAdminTheme(previewing ?? saved, false);
  }, [previewing, saved]);
  useEffect(() => () => applyAdminTheme(saved, false), [saved]);

  const apply = (entry: AdminThemeEntry) => {
    setPreviewId(null);
    setTheme.mutate(entry.id, {
      onSuccess: (data) => applyAdminTheme(data.theme ?? DEFAULT_ADMIN_THEME),
    });
  };
  const reset = () => {
    setPreviewId(null);
    setTheme.mutate(null, { onSuccess: () => applyAdminTheme(DEFAULT_ADMIN_THEME) });
  };

  const loading = pref.isLoading || catalog.isLoading;

  return (
    <div className="page">
      <PageHeader
        title={t('adminControlStudio.title')}
        subtitle={t('adminControlStudio.subtitle')}
      />

      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        <Link to="/admin/academies" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">apartment</span>
          <span className="font-heading text-sm font-bold">
            {t('adminControlStudio.actions.academies')}
          </span>
        </Link>
        <Link to="/admin/security" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">gpp_maybe</span>
          <span className="font-heading text-sm font-bold">
            {t('adminControlStudio.actions.security')}
          </span>
        </Link>
        <Link to="/admin/payouts" className="card card-hover flex items-center gap-3 p-4">
          <span className="material-symbols-outlined text-primary">payments</span>
          <span className="font-heading text-sm font-bold">
            {t('adminControlStudio.actions.payouts')}
          </span>
        </Link>
      </section>

      {/* What the console wears right now — and, while previewing, what it is trying on. */}
      <section className="card mb-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <div className="sm:w-64">
          <LookPreview tokens={(previewing ?? saved).tokens} tall />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">
            {previewing
              ? t('adminControlStudio.theme.previewingLabel')
              : t('adminControlStudio.theme.currentLabel')}
          </p>
          <p className="mt-1 font-heading text-2xl font-extrabold">{(previewing ?? saved).name}</p>
          <p className="text-sm text-on-surface-variant">
            {(previewing ?? saved).subtitle ??
              t(`adminControlStudio.shelf.${shelfOf(previewing ?? saved)}`)}
            {!activeId && !previewing && <> · {t('adminControlStudio.theme.platformDefault')}</>}
          </p>
          <p className="mt-2 text-xs text-outline">{t('adminControlStudio.theme.hint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {previewing && (
              <>
                <button
                  type="button"
                  className="btn-primary px-4 py-2 text-sm"
                  disabled={setTheme.isPending}
                  onClick={() => apply(previewing)}
                >
                  {t('adminControlStudio.theme.applyThis')}
                </button>
                <button
                  type="button"
                  className="btn-secondary px-4 py-2 text-sm"
                  onClick={() => setPreviewId(null)}
                >
                  {t('adminControlStudio.theme.revert')}
                </button>
              </>
            )}
            {!previewing && activeId && (
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                disabled={setTheme.isPending}
                onClick={reset}
              >
                {t('adminControlStudio.theme.reset')}
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="scroll-x -mx-6 px-6 sm:mx-0 sm:px-0">
          <div className="inline-flex items-center gap-2">
            {SHELVES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setShelf(s)}
                className={`whitespace-nowrap rounded-xl border px-4 py-2 text-sm font-bold transition ${
                  shelf === s
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-outline-variant text-on-surface-variant hover:border-outline'
                }`}
              >
                {t(`adminControlStudio.shelf.${s}`)}
                <span className="ms-1.5 opacity-70">{counts.get(s) ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
        <input
          className="input sm:ms-auto sm:w-64"
          placeholder={t('adminControlStudio.theme.search') as string}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="mb-8">
          <EmptyState icon="palette" title={t('adminControlStudio.theme.empty')} />
        </div>
      ) : (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {shown.map((entry) => (
            <LookCard
              key={entry.id}
              entry={entry}
              active={activeId === entry.id}
              previewing={previewId === entry.id}
              busy={setTheme.isPending}
              onPreview={() => setPreviewId((cur) => (cur === entry.id ? null : entry.id))}
              onApply={() => apply(entry)}
              t={t}
            />
          ))}
        </div>
      )}

      <LivePreviewPanel />
    </div>
  );
}
