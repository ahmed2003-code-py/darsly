import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { CardGridSkeleton, EmptyState, Stars } from '../../components/ui';
import { Stagger, StaggerItem } from '../../components/motion';
import Pager from '../../components/Pager';
import { FilterBar, FilterSheet } from '../../components/FilterBar';

/**
 * The teacher directory.
 *
 * Rebuilt to sit alongside the course catalogue rather than beside it: same
 * toolbar, same filter language, same paging. Two discovery pages that behave
 * differently read as two products, and this one had drifted — filters that
 * needed an Apply button, an unlabelled icon next to every price, names cut off
 * mid-word, and every page of results at the same URL.
 *
 * Everything is now in the URL, so a filtered directory is a link.
 */

interface Named {
  id: string;
  nameAr: string;
  nameEn: string;
  icon?: string | null;
}

interface Teacher {
  id: string;
  slug: string;
  fullName: string;
  avatarUrl: string | null;
  bio: string | null;
  verified: boolean;
  subject: Named | null;
  grades: Named[];
  coursesCount: number;
  studentsCount: number;
  minPriceCents: number | null;
  avgRating: number | null;
  reviewsCount: number;
}

interface Page {
  items: Teacher[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 12;
const SORTS = ['rating', 'newest', 'priceAsc', 'priceDesc'] as const;
type Q = Record<string, string>;

export default function DiscoveryPage() {
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

  // Typed now, requested when you stop. A filter that needs an Apply button is
  // a filter most people never use.
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

  const { data: subjects } = useQuery<Named[]>({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
    staleTime: 5 * 60_000,
  });
  const { data: grades } = useQuery<Named[]>({
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
      priceMinCents: get('priceMin') ? Number(get('priceMin')) * 100 : undefined,
      priceMaxCents: get('priceMax') ? Number(get('priceMax')) * 100 : undefined,
      sort: get('sort') || 'rating',
      page,
      pageSize: PAGE_SIZE,
    }),
    [params], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const { data, isLoading, isFetching } = useQuery<Page>({
    queryKey: ['teachers', query],
    queryFn: async () => (await api.get('/teachers', { params: query })).data,
    placeholderData: keepPreviousData,
  });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const name = (x: Named | null | undefined) => (!x ? '' : ar ? x.nameAr : x.nameEn);

  // The subject keeps its place in the bar; everything else lives in the sheet.
  const SHEET_KEYS = ['gradeId', 'language', 'priceMin', 'priceMax'];
  const active = SHEET_KEYS.filter((k) => get(k)).length;
  const [sheet, setSheet] = useState(false);

  const activeChips = [
    get('gradeId') && { key: 'gradeId', label: name((grades ?? []).find((g) => g.id === get('gradeId'))) },
    get('language') && { key: 'language', label: t(get('language') === 'ar' ? 'discovery.arabic' : 'discovery.english') },
    get('priceMin') && { key: 'priceMin', label: `${t('discovery.min')} ${get('priceMin')}` },
    get('priceMax') && { key: 'priceMax', label: `${t('discovery.max')} ${get('priceMax')}` },
  ].filter(Boolean) as { key: string; label: string }[];

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <header className="mb-8">
        <h1 className="display">{t('discovery.title')}</h1>
        <p className="mt-2 max-w-prose text-on-surface-variant">
          {get('q') ? t('discovery.resultsFor', { q: get('q') }) : t('discovery.subtitle')}
        </p>
      </header>

      <FilterBar
        chips={(subjects ?? []).map((x) => ({ id: x.id, label: name(x) }))}
        selectedChip={get('subjectId')}
        onChip={(id) => patch({ subjectId: id })}
        search={typed}
        onSearch={setTyped}
        searchPlaceholder={t('discovery.searchPh')}
        sort={get('sort') || 'rating'}
        onSort={(v) => patch({ sort: v })}
        sorts={SORTS.map((x) => ({ value: x, label: t(`discovery.sort.${x}`) }))}
        sortLabel={t('discovery.sortBy')}
        activeCount={active}
        activeChips={activeChips}
        onRemove={(k) => patch({ [k]: '' })}
        onClear={() => patch(Object.fromEntries(SHEET_KEYS.map((k) => [k, ''])))}
        onOpen={() => setSheet(true)}
        busy={isFetching && !isLoading}
      />

      <FilterSheet open={sheet} onClose={() => setSheet(false)} count={active}>
        <label className="mb-5 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('discovery.grade')}</span>
          <select className="input" value={get('gradeId')} onChange={(e) => patch({ gradeId: e.target.value })}>
            <option value="">{t('discovery.allGrades')}</option>
            {(grades ?? []).map((g) => (
              <option key={g.id} value={g.id}>{name(g)}</option>
            ))}
          </select>
        </label>

        <label className="mb-5 block">
          <span className="mb-1.5 block text-sm font-semibold text-on-surface-variant">{t('discovery.language')}</span>
          <select className="input" value={get('language')} onChange={(e) => patch({ language: e.target.value })}>
            <option value="">{t('discovery.allLanguages')}</option>
            <option value="ar">{t('discovery.arabic')}</option>
            <option value="en">{t('discovery.english')}</option>
          </select>
        </label>

        <p className="mb-2 text-sm font-semibold text-on-surface-variant">{t('discovery.price')}</p>
        <div className="flex items-center gap-2">
          <input
            className="input" type="number" min={0} inputMode="numeric"
            placeholder={t('discovery.min')} value={get('priceMin')}
            onChange={(e) => patch({ priceMin: e.target.value })}
          />
          <span className="text-outline">—</span>
          <input
            className="input" type="number" min={0} inputMode="numeric"
            placeholder={t('discovery.max')} value={get('priceMax')}
            onChange={(e) => patch({ priceMax: e.target.value })}
          />
        </div>
      </FilterSheet>

      <div>
        <section aria-live="polite">
          <p className="mb-4 text-sm text-on-surface-variant">
            {isLoading ? t('discovery.loading') : t('discovery.count', { n: data?.total ?? 0 })}
          </p>

          {isLoading ? (
            <CardGridSkeleton count={6} />
          ) : !data?.items.length ? (
            <EmptyState icon="search_off" title={t('discovery.noResults')} hint={t('discovery.noResultsHint')} />
          ) : (
            <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {data.items.map((tc) => (
                <StaggerItem key={tc.id} className="h-full">
                  <TeacherCard teacher={tc} t={t} name={name} />
                </StaggerItem>
              ))}
            </Stagger>
          )}

          <Pager page={page} pages={pages} onGo={(p) => patch({ page: String(p) }, false)} />
        </section>
      </div>
    </div>
  );
}

function TeacherCard({
  teacher: tc,
  t,
  name,
}: {
  teacher: Teacher;
  t: (k: string, o?: Record<string, unknown>) => string;
  name: (x: Named | null | undefined) => string;
}) {
  // A teacher with no courses has no price to start from, and "—" beside the
  // words "starting from" reads as a rendering fault rather than as a fact.
  const isNew = tc.coursesCount === 0;

  return (
    <Link
      to={`/t/${tc.slug}`}
      className="card card-hover flex h-full flex-col gap-3 p-5"
    >
      <div className="flex items-start gap-3">
        {tc.avatarUrl ? (
          <img
            src={tc.avatarUrl}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-outline-variant"
          />
        ) : (
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading text-xl font-bold text-on-primary-fixed-variant">
            {tc.fullName?.trim()?.charAt(0)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-1.5">
            {/* Two lines, not an ellipsis. A directory that cuts people's names
                in half is the first thing that looks unfinished. */}
            <span className="line-clamp-2 font-heading text-base font-bold leading-snug">{tc.fullName}</span>
            {tc.verified && (
              <span className="material-symbols-outlined mt-0.5 shrink-0 text-[16px] text-primary" title={t('discovery.verified')}>
                verified
              </span>
            )}
          </span>
          {tc.subject && (
            <span className="mt-1 block truncate text-sm text-on-surface-variant">
              {name(tc.subject)}
              {tc.grades?.length ? ` · ${name(tc.grades[0])}` : ''}
            </span>
          )}
        </span>
      </div>

      {tc.avgRating != null ? (
        <span className="flex items-center gap-1.5 text-sm">
          {/* `Stars` prints the figure itself — repeating it here rendered
              every rating twice ("5 5 (2 reviews)"). */}
          <Stars rating={tc.avgRating} />
          <span className="text-on-surface-variant">
            {t('discovery.reviewsCount', { count: tc.reviewsCount })}
          </span>
        </span>
      ) : (
        <span className="w-fit rounded-md bg-primary-fixed px-2 py-0.5 text-xs font-semibold text-on-primary-fixed-variant">
          {t('discovery.newTeacher')}
        </span>
      )}

      {tc.bio && (
        <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-on-surface-variant">{tc.bio}</p>
      )}

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[15px]">menu_book</span>
          {t('discovery.coursesCount', { count: tc.coursesCount })}
        </span>
        <span className="flex items-center gap-1">
          <span className="material-symbols-outlined text-[15px]">group</span>
          {t('discovery.studentsCount', { count: tc.studentsCount })}
        </span>
      </p>

      <span className="mt-auto flex items-end justify-between gap-2 border-t border-outline-variant pt-3">
        <span className="min-w-0">
          {isNew || tc.minPriceCents == null ? (
            <span className="text-sm text-on-surface-variant">{t('discovery.noCoursesYet')}</span>
          ) : (
            <>
              <span className="block text-[11px] text-on-surface-variant">{t('discovery.startingFrom')}</span>
              <span className="font-heading text-lg font-bold">{egp(tc.minPriceCents)}</span>
            </>
          )}
        </span>
        <span className="btn-secondary shrink-0 px-4 py-2 text-xs">{t('discovery.viewProfile')}</span>
      </span>
    </Link>
  );
}
