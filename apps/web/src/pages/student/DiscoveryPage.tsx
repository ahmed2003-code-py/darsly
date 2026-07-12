import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { CardGridSkeleton, EmptyState, PageHeader, Stars } from '../../components/ui';
import { Stagger, StaggerItem } from '../../components/motion';

interface Filters {
  subjectId: string;
  gradeId: string;
  language: string;
  priceMin: string;
  priceMax: string;
}

const EMPTY: Filters = { subjectId: '', gradeId: '', language: '', priceMin: '', priceMax: '' };

export default function DiscoveryPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? ''; // driven by the TopBar search

  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState('rating');
  const [page, setPage] = useState(1);

  // Reset to first page whenever the search text changes.
  useEffect(() => setPage(1), [q]);

  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
  });
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['teachers', applied, sort, page, q],
    queryFn: async () =>
      (
        await api.get('/teachers', {
          params: {
            q: q || undefined,
            subjectId: applied.subjectId || undefined,
            gradeId: applied.gradeId || undefined,
            language: applied.language || undefined,
            priceMinCents: applied.priceMin ? Number(applied.priceMin) * 100 : undefined,
            priceMaxCents: applied.priceMax ? Number(applied.priceMax) * 100 : undefined,
            sort,
            page,
            pageSize: 9,
          },
        })
      ).data,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeFilters =
    (applied.subjectId ? 1 : 0) + (applied.gradeId ? 1 : 0) + (applied.language ? 1 : 0) +
    (applied.priceMin || applied.priceMax ? 1 : 0);

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader
        title={t('discovery.title')}
        subtitle={q ? t('discovery.resultsFor', { q }) : t('discovery.subtitle')}
        action={
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            {t('discovery.sortBy')}
            <select
              className="input w-auto py-2"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
            >
              {['rating', 'priceAsc', 'priceDesc', 'newest'].map((s) => (
                <option key={s} value={s}>
                  {t(`discovery.sort.${s}`)}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Filter panel */}
        <aside className="card h-fit w-full shrink-0 lg:sticky lg:top-24 lg:w-72">
          <div className="mb-4 flex items-center justify-between border-b border-outline-variant/50 pb-3">
            <h2 className="flex items-center gap-2 font-heading text-lg font-bold">
              <span className="material-symbols-outlined text-primary">tune</span>
              {t('discovery.filters')}
              {activeFilters > 0 && (
                <span className="pill bg-primary text-on-primary">{activeFilters}</span>
              )}
            </h2>
            <button
              className="text-sm text-primary hover:underline"
              onClick={() => {
                setDraft(EMPTY);
                setApplied(EMPTY);
              }}
            >
              {t('discovery.clearAll')}
            </button>
          </div>

          <p className="mb-2 text-sm font-bold">{t('discovery.subject')}</p>
          <div className="mb-5 space-y-1">
            {(subjects ?? []).map((s: any) => {
              const on = draft.subjectId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setDraft({ ...draft, subjectId: on ? '' : s.id })}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition ${
                    on ? 'bg-primary-fixed font-bold text-primary' : 'hover:bg-surface-container-low'
                  }`}
                >
                  {s.icon && <span className="material-symbols-outlined text-lg">{s.icon}</span>}
                  {ar ? s.nameAr : s.nameEn}
                </button>
              );
            })}
          </div>

          <p className="mb-2 text-sm font-bold">{t('discovery.grade')}</p>
          <select
            className="input mb-5 py-2.5"
            value={draft.gradeId}
            onChange={(e) => setDraft({ ...draft, gradeId: e.target.value })}
          >
            <option value="">{t('discovery.allGrades')}</option>
            {(grades ?? []).map((g: any) => (
              <option key={g.id} value={g.id}>
                {ar ? g.nameAr : g.nameEn}
              </option>
            ))}
          </select>

          <p className="mb-2 text-sm font-bold">{t('discovery.language')}</p>
          <select
            className="input mb-5 py-2.5"
            value={draft.language}
            onChange={(e) => setDraft({ ...draft, language: e.target.value })}
          >
            <option value="">{t('discovery.allLanguages')}</option>
            <option value="ar">{t('discovery.arabic')}</option>
            <option value="en">{t('discovery.english')}</option>
          </select>

          <p className="mb-2 text-sm font-bold">{t('discovery.price')}</p>
          <div className="mb-6 flex items-center gap-2">
            <input
              className="input py-2.5"
              inputMode="numeric"
              placeholder={t('discovery.min')}
              value={draft.priceMin}
              onChange={(e) => setDraft({ ...draft, priceMin: e.target.value.replace(/\D/g, '') })}
            />
            <span className="text-outline">—</span>
            <input
              className="input py-2.5"
              inputMode="numeric"
              placeholder={t('discovery.max')}
              value={draft.priceMax}
              onChange={(e) => setDraft({ ...draft, priceMax: e.target.value.replace(/\D/g, '') })}
            />
          </div>

          <button
            className="btn-primary w-full"
            onClick={() => {
              setApplied(draft);
              setPage(1);
            }}
          >
            {t('discovery.apply')}
          </button>
        </aside>

        {/* Results */}
        <section className="min-w-0 flex-1">
          {isLoading ? (
            <CardGridSkeleton count={6} />
          ) : !data?.items.length ? (
            <EmptyState icon="search_off" title={t('discovery.noResults')} hint={t('discovery.noResultsHint')} />
          ) : (
            <>
              <Stagger className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {data.items.map((tc: any) => (
                  <StaggerItem key={tc.id} className="h-full">
                  <article className="card card-hover flex h-full flex-col p-5">
                    {/* Avatar on the inline-start (right in RTL), text flows left — per design */}
                    <div className="mb-3 flex items-start gap-3">
                      {tc.avatarUrl ? (
                        <img src={tc.avatarUrl} alt="" loading="lazy" className="h-16 w-16 rounded-full object-cover ring-1 ring-outline-variant" />
                      ) : (
                        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-primary-fixed font-heading text-2xl font-bold text-primary">
                          {tc.fullName?.trim()?.charAt(0)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate font-heading text-lg font-bold">{tc.fullName}</h3>
                          {tc.verified && (
                            <span className="material-symbols-outlined text-lg text-primary" title={t('discovery.verified')}>
                              verified
                            </span>
                          )}
                        </div>
                        <p className="truncate text-sm text-primary">
                          {tc.subject ? (ar ? tc.subject.nameAr : tc.subject.nameEn) : '—'}
                          {tc.grades?.length ? ` · ${ar ? tc.grades[0].nameAr : tc.grades[0].nameEn}` : ''}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-xs text-outline">
                          <Stars rating={tc.avgRating} />
                          <span>{t('discovery.reviewsCount', { count: tc.reviewsCount })}</span>
                        </div>
                      </div>
                    </div>

                    <p className="mb-4 line-clamp-2 flex-1 text-sm leading-relaxed text-on-surface-variant">{tc.bio}</p>

                    <div className="mb-4 flex flex-wrap gap-2">
                      <span className="pill bg-surface-container-high text-on-surface-variant">
                        <span className="material-symbols-outlined text-sm">menu_book</span>
                        {t('discovery.coursesCount', { count: tc.coursesCount })}
                      </span>
                      <span className="pill bg-surface-container-high text-on-surface-variant">
                        <span className="material-symbols-outlined text-sm">group</span>
                        {t('discovery.studentsCount', { count: tc.studentsCount })}
                      </span>
                    </div>

                    <div className="flex items-center justify-between border-t border-outline-variant/50 pt-4">
                      <div>
                        <p className="text-xs text-outline">{t('discovery.startingFrom')}</p>
                        <p className="font-heading text-2xl font-extrabold">{egp(tc.minPriceCents)}</p>
                      </div>
                      <Link to={`/t/${tc.slug}`} className="btn-primary px-5 py-2.5 text-sm">
                        {t('discovery.viewProfile')}
                      </Link>
                    </div>
                  </article>
                  </StaggerItem>
                ))}
              </Stagger>

              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={`h-10 w-10 rounded-full font-semibold transition-colors ${
                        p === page
                          ? 'bg-primary text-on-primary'
                          : 'border border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low'
                      }`}
                      onClick={() => setPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
