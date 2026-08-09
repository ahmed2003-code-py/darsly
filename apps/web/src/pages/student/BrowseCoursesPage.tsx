import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { CardGridSkeleton, EmptyState, Stars } from '../../components/ui';
import { FilterBar, FilterSheet } from '../../components/FilterBar';
import { Stagger, StaggerItem } from '../../components/motion';
import Pager from '../../components/Pager';

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

  const name = (x: { nameAr: string; nameEn: string } | null | undefined) =>
    !x ? '' : ar ? x.nameAr : x.nameEn;

  // Everything except the subject, which keeps its place in the bar.
  const SHEET_KEYS = ['gradeId', 'language', 'free', 'hasPreview', 'priceMin', 'priceMax'];
  const active = SHEET_KEYS.filter((k) => get(k)).length;
  const [sheet, setSheet] = useState(false);

  const activeChips = [
    get('gradeId') && { key: 'gradeId', label: name((grades ?? []).find((g) => g.id === get('gradeId'))) },
    get('language') && { key: 'language', label: t(get('language') === 'ar' ? 'browse.arabic' : 'browse.english') },
    get('free') === '1' && { key: 'free', label: t('browse.freeOnly') },
    get('hasPreview') === '1' && { key: 'hasPreview', label: t('browse.previewOnly') },
    get('priceMin') && { key: 'priceMin', label: `${t('browse.min')} ${get('priceMin')}` },
    get('priceMax') && { key: 'priceMax', label: `${t('browse.max')} ${get('priceMax')}` },
  ].filter(Boolean) as { key: string; label: string }[];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <header className="mb-8">
        <h1 className="display">{t('browse.title')}</h1>
        <p className="mt-2 max-w-prose text-on-surface-variant">{t('browse.subtitle')}</p>
      </header>

      <FilterBar
        chips={(subjects ?? []).map((x) => ({ id: x.id, label: name(x) }))}
        selectedChip={get('subjectId')}
        onChip={(id) => patch({ subjectId: id })}
        search={typed}
        onSearch={setTyped}
        searchPlaceholder={t('browse.searchPh')}
        sort={get('sort') || 'newest'}
        onSort={(v) => patch({ sort: v })}
        sorts={SORTS.map((x) => ({ value: x, label: t(`browse.sort.${x}`) }))}
        sortLabel={t('browse.sortBy')}
        activeCount={active}
        activeChips={activeChips}
        onRemove={(k) => patch({ [k]: '' })}
        onClear={() => patch(Object.fromEntries(SHEET_KEYS.map((k) => [k, ''])))}
        onOpen={() => setSheet(true)}
        busy={isFetching && !isLoading}
      />

      <FilterSheet open={sheet} onClose={() => setSheet(false)} count={active}>
        <SheetFilters t={t} get={get} patch={patch} grades={grades ?? []} name={name} />
      </FilterSheet>

      <div>
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
            <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {data.items.map((c) => (
                <StaggerItem key={c.id}>
                  <CourseCard course={c} ar={ar} t={t} name={name} />
                </StaggerItem>
              ))}
            </Stagger>
          )}

          <Pager page={page} pages={data?.pages ?? 1} onGo={(p) => patch({ page: String(p) }, false)} />
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

function SheetFilters({
  t, get, patch, grades, name,
}: {
  t: (k: string, o?: Record<string, unknown>) => string;
  get: (k: string) => string;
  patch: (n: Q, resetPage?: boolean) => void;
  grades: { id: string; nameAr: string; nameEn: string }[];
  name: (x: { nameAr: string; nameEn: string } | null | undefined) => string;
}) {
  return (
    <>
      <label className="mb-5 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('browse.grade')}</span>
        <select className="input" value={get('gradeId')} onChange={(e) => patch({ gradeId: e.target.value })}>
          <option value="">{t('browse.allGrades')}</option>
          {grades.map((g) => (
            <option key={g.id} value={g.id}>{name(g)}</option>
          ))}
        </select>
      </label>

      <label className="mb-5 block">
        <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('browse.language')}</span>
        <select className="input" value={get('language')} onChange={(e) => patch({ language: e.target.value })}>
          <option value="">{t('browse.allLanguages')}</option>
          <option value="ar">{t('browse.arabic')}</option>
          <option value="en">{t('browse.english')}</option>
        </select>
      </label>

      <p className="mb-2 text-sm font-semibold text-on-surface-variant">{t('browse.price')}</p>
      <div className="mb-5 flex items-center gap-2">
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
    </>
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

