import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { CardGridSkeleton, EmptyState, Stars } from '../../components/ui';
import { Stagger, StaggerItem } from '../../components/motion';

/**
 * The course catalogue.
 *
 * Until now a published course was reachable only by someone who already knew
 * its teacher — the platform had teacher discovery and no course discovery at
 * all, so a teacher could publish, look for their own work, and not find it.
 *
 * Everything here is driven by the URL, so a filtered view can be shared, and
 * every filter and the page itself resolve in SQL rather than by loading the
 * catalogue and slicing it in the browser.
 */

interface Course {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string | null;
  subject: { id: string; nameAr: string; nameEn: string } | null;
  grade: { id: string; nameAr: string; nameEn: string } | null;
  pricingModel: 'ONE_TIME' | 'MONTHLY_SUBSCRIPTION';
  priceCents: number;
  lessonsCount: number;
  totalDurationSec: number;
  freePreviewCount: number;
  studentsCount: number;
  avgRating: number | null;
  reviewsCount: number;
  teacher: { id: string; slug: string; fullName: string; avatarUrl: string | null; verified: boolean };
}

interface Page {
  items: Course[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

const PAGE_SIZE = 10;
const SORTS = ['newest', 'popular', 'rating', 'priceAsc', 'priceDesc'] as const;

/** Read/write the whole view from the URL, so any result set is a link. */
type Q = Record<string, string>;

export default function BrowseCoursesPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [params, setParams] = useSearchParams();

  const get = (k: string) => params.get(k) ?? '';
  const page = Math.max(1, Number(params.get('page') || 1));

  const patch = (next: Q, resetPage = true) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) merged.set(k, v);
      else merged.delete(k);
    }
    if (resetPage) merged.delete('page');
    setParams(merged, { replace: true });
  };

  // The search box updates as you type; the request waits until you stop.
  // Filtering on every keystroke is what made the old page feel slow — it was
  // not the query, it was the number of them.
  const [typed, setTyped] = useState(get('q'));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => patch({ q: typed }), 300);
    return () => clearTimeout(id);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTyped(get('q')), [params.get('q')]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: subjects } = useQuery<{ id: string; nameAr: string; nameEn: string }[]>({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
    staleTime: 5 * 60_000,
  });
  const { data: grades } = useQuery<{ id: string; nameAr: string; nameEn: string }[]>({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
    staleTime: 5 * 60_000,
  });

  const query = useMemo(
    () => ({
      q: get('q') || undefined,
      subjectId: get('subjectId') || undefined,
      gradeId: get('gradeId') || undefined,
      language: get('language') || undefined,
      free: get('free') === '1' || undefined,
      hasPreview: get('hasPreview') === '1' || undefined,
      priceMinCents: get('priceMin') ? Number(get('priceMin')) * 100 : undefined,
      priceMaxCents: get('priceMax') ? Number(get('priceMax')) * 100 : undefined,
      sort: get('sort') || 'newest',
      page,
      pageSize: PAGE_SIZE,
    }),
    [params], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const { data, isLoading, isFetching } = useQuery<Page>({
    queryKey: ['browse-courses', query],
    queryFn: async () => (await api.get('/courses', { params: query })).data,
    // The previous page stays on screen while the next one loads, so paging
    // does not flash an empty grid.
    placeholderData: keepPreviousData,
  });

  const active = ['subjectId', 'gradeId', 'language', 'free', 'hasPreview', 'priceMin', 'priceMax']
    .filter((k) => get(k)).length;

  const name = (x: { nameAr: string; nameEn: string } | null | undefined) =>
    !x ? '' : ar ? x.nameAr : x.nameEn;

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <header className="mb-8">
        <h1 className="display">{t('browse.title')}</h1>
        <p className="mt-2 max-w-prose text-on-surface-variant">{t('browse.subtitle')}</p>
      </header>

      {/* Search and sort sit above everything: they are what a student reaches
          for first, and burying them in the filter panel is what made the old
          page feel like a form. */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="material-symbols-outlined pointer-events-none absolute inset-y-0 start-4 my-auto h-fit text-[20px] text-outline">
            search
          </span>
          <input
            className="input h-12 ps-12 text-base"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t('browse.searchPh')}
            aria-label={t('browse.searchPh')}
          />
          {isFetching && !isLoading && (
            <span className="absolute inset-y-0 end-4 my-auto h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
          )}
        </label>
        <select
          className="input h-12 sm:w-52"
          value={get('sort') || 'newest'}
          onChange={(e) => patch({ sort: e.target.value })}
          aria-label={t('browse.sortBy')}
        >
          {SORTS.map((s) => (
            <option key={s} value={s}>{t(`browse.sort.${s}`)}</option>
          ))}
        </select>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <FilterPanel
          ar={ar}
          t={t}
          get={get}
          patch={patch}
          subjects={subjects ?? []}
          grades={grades ?? []}
          active={active}
        />

        <section aria-live="polite">
          <p className="mb-4 text-sm text-on-surface-variant">
            {isLoading ? t('browse.loading') : t('browse.count', { n: data?.total ?? 0 })}
          </p>

          {isLoading ? (
            <CardGridSkeleton count={6} />
          ) : !data?.items.length ? (
            <EmptyState
              icon="search_off"
              title={t('browse.emptyTitle')}
              hint={active || get('q') ? t('browse.emptyFiltered') : t('browse.emptyAll')}
            />
          ) : (
            <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.items.map((c) => (
                <StaggerItem key={c.id}>
                  <CourseCard course={c} ar={ar} t={t} name={name} />
                </StaggerItem>
              ))}
            </Stagger>
          )}

          {data && data.pages > 1 && (
            <Pager page={data.page} pages={data.pages} onGo={(p) => patch({ page: String(p) }, false)} t={t} />
          )}
        </section>
      </div>
    </div>
  );
}

function CourseCard({
  course: c,
  ar,
  t,
  name,
}: {
  course: Course;
  ar: boolean;
  t: (k: string, o?: Record<string, unknown>) => string;
  name: (x: { nameAr: string; nameEn: string } | null | undefined) => string;
}) {
  const hours = Math.floor(c.totalDurationSec / 3600);
  const mins = Math.round((c.totalDurationSec % 3600) / 60);
  return (
    <Link
      to={`/course/${c.id}`}
      className="card card-hover flex h-full flex-col gap-3 p-0 overflow-hidden"
    >
      <div className="relative aspect-[16/10] w-full bg-surface-container">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="material-symbols-outlined text-4xl text-outline">menu_book</span>
          </span>
        )}
        {c.freePreviewCount > 0 && (
          <span className="absolute bottom-2 start-2 rounded-lg bg-surface-container-lowest/95 px-2 py-1 text-xs font-bold text-primary">
            {t('browse.freePreview')}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 px-4 pb-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-on-surface-variant">
          {c.subject && <span className="rounded-md bg-primary-fixed px-2 py-0.5 font-semibold text-on-primary-fixed-variant">{name(c.subject)}</span>}
          {c.grade && <span className="rounded-md bg-surface-container px-2 py-0.5">{name(c.grade)}</span>}
        </div>

        <h3 className="line-clamp-2 font-heading text-base font-bold leading-snug">{c.title}</h3>

        <p className="flex items-center gap-1.5 text-sm text-on-surface-variant">
          {c.teacher.fullName}
          {c.teacher.verified && (
            <span className="material-symbols-outlined text-[14px] text-primary">verified</span>
          )}
        </p>

        {c.avgRating != null ? (
          <span className="flex items-center gap-1.5 text-sm">
            <Stars rating={c.avgRating} />
            <span className="font-bold">{c.avgRating}</span>
            <span className="text-on-surface-variant">({c.reviewsCount})</span>
          </span>
        ) : (
          <span className="text-sm text-outline">{t('browse.noReviews')}</span>
        )}

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[15px]">play_lesson</span>
            {t('browse.lessons', { n: c.lessonsCount })}
          </span>
          {c.totalDurationSec > 0 && (
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[15px]">schedule</span>
              {hours ? `${hours}${ar ? 'س' : 'h'} ` : ''}{mins}{ar ? 'د' : 'm'}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[15px]">group</span>
            {c.studentsCount}
          </span>
        </p>

        <div className="mt-auto flex items-end justify-between gap-2 border-t border-outline-variant pt-3">
          <span>
            <span className="block text-[11px] text-on-surface-variant">
              {c.pricingModel === 'MONTHLY_SUBSCRIPTION' ? t('browse.perMonth') : t('browse.price')}
            </span>
            <span className="font-heading text-lg font-bold">
              {c.priceCents === 0 ? t('browse.free') : egp(c.priceCents)}
            </span>
          </span>
          <span className="btn-secondary px-4 py-2 text-xs">{t('browse.view')}</span>
        </div>
      </div>
    </Link>
  );
}

function FilterPanel({
  ar, t, get, patch, subjects, grades, active,
}: {
  ar: boolean;
  t: (k: string, o?: Record<string, unknown>) => string;
  get: (k: string) => string;
  patch: (n: Q, resetPage?: boolean) => void;
  subjects: { id: string; nameAr: string; nameEn: string }[];
  grades: { id: string; nameAr: string; nameEn: string }[];
  active: number;
}) {
  const name = (x: { nameAr: string; nameEn: string }) => (ar ? x.nameAr : x.nameEn);
  const clear = () =>
    patch({ subjectId: '', gradeId: '', language: '', free: '', hasPreview: '', priceMin: '', priceMax: '' });

  return (
    <aside className="card h-fit lg:sticky lg:top-24">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-heading font-bold">
          <span className="material-symbols-outlined text-[20px]">tune</span>
          {t('browse.filters')}
          {active > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-on-primary">{active}</span>
          )}
        </h2>
        {active > 0 && (
          <button className="text-sm font-semibold text-primary hover:underline" onClick={clear}>
            {t('browse.clear')}
          </button>
        )}
      </div>

      {/* Subjects as chips rather than a list of radio-like rows: it is the
          filter students reach for most, and one tap should apply it. */}
      <p className="mb-2 text-sm font-semibold text-on-surface-variant">{t('browse.subject')}</p>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {subjects.map((s) => {
          const on = get('subjectId') === s.id;
          return (
            <button
              key={s.id}
              onClick={() => patch({ subjectId: on ? '' : s.id })}
              aria-pressed={on}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                on
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
              }`}
            >
              {name(s)}
            </button>
          );
        })}
      </div>

      <label className="mb-4 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('browse.grade')}</span>
        <select className="input" value={get('gradeId')} onChange={(e) => patch({ gradeId: e.target.value })}>
          <option value="">{t('browse.allGrades')}</option>
          {grades.map((g) => (
            <option key={g.id} value={g.id}>{name(g)}</option>
          ))}
        </select>
      </label>

      <label className="mb-4 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('browse.language')}</span>
        <select className="input" value={get('language')} onChange={(e) => patch({ language: e.target.value })}>
          <option value="">{t('browse.allLanguages')}</option>
          <option value="ar">{t('browse.arabic')}</option>
          <option value="en">{t('browse.english')}</option>
        </select>
      </label>

      <p className="mb-2 text-sm font-semibold text-on-surface-variant">{t('browse.price')}</p>
      <div className="mb-3 flex items-center gap-2">
        <input
          className="input" type="number" min={0} inputMode="numeric"
          placeholder={t('browse.min')} value={get('priceMin')}
          onChange={(e) => patch({ priceMin: e.target.value })}
          disabled={get('free') === '1'}
        />
        <span className="text-outline">—</span>
        <input
          className="input" type="number" min={0} inputMode="numeric"
          placeholder={t('browse.max')} value={get('priceMax')}
          onChange={(e) => patch({ priceMax: e.target.value })}
          disabled={get('free') === '1'}
        />
      </div>

      <Toggle
        label={t('browse.freeOnly')}
        on={get('free') === '1'}
        onChange={(v) => patch({ free: v ? '1' : '', ...(v ? { priceMin: '', priceMax: '' } : {}) })}
      />
      <Toggle
        label={t('browse.previewOnly')}
        on={get('hasPreview') === '1'}
        onChange={(v) => patch({ hasPreview: v ? '1' : '' })}
      />
    </aside>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-primary"
      />
      {label}
    </label>
  );
}

/**
 * Paging with the ends always reachable. A long catalogue collapses the middle
 * rather than growing a row of forty numbers.
 */
function Pager({
  page, pages, onGo, t,
}: {
  page: number; pages: number; onGo: (p: number) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const shown = [...new Set([1, ...around, pages])].sort((a, b) => a - b);

  return (
    <nav className="mt-8 flex flex-wrap items-center justify-center gap-1.5" aria-label={t('browse.pagination')}>
      <button
        className="btn-secondary px-3 py-2 disabled:opacity-40"
        onClick={() => onGo(page - 1)}
        disabled={page <= 1}
        aria-label={t('browse.prev')}
      >
        <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">chevron_left</span>
      </button>

      {shown.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - shown[i - 1] > 1 && <span className="px-1 text-outline">…</span>}
          <button
            onClick={() => onGo(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`min-w-10 rounded-xl px-3 py-2 font-heading text-sm font-semibold transition-colors ${
              p === page
                ? 'bg-primary text-on-primary'
                : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
            }`}
          >
            {p}
          </button>
        </span>
      ))}

      <button
        className="btn-secondary px-3 py-2 disabled:opacity-40"
        onClick={() => onGo(page + 1)}
        disabled={page >= pages}
        aria-label={t('browse.next')}
      >
        <span className="material-symbols-outlined text-[18px] rtl:-scale-x-100">chevron_right</span>
      </button>
    </nav>
  );
}
