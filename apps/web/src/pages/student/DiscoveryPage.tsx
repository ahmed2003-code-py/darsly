import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { Badge, EmptyState, Spinner, Stars } from '../../components/ui';

interface Filters {
  q: string;
  subjectId: string;
  gradeId: string;
  language: string;
  priceMin: string; // EGP as typed by the user
  priceMax: string;
  sort: string;
  page: number;
}

const INITIAL: Filters = {
  q: '',
  subjectId: '',
  gradeId: '',
  language: '',
  priceMin: '',
  priceMax: '',
  sort: 'rating',
  page: 1,
};

export default function DiscoveryPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  // draft = what the filter panel shows; applied = what the query uses.
  const [draft, setDraft] = useState<Filters>(INITIAL);
  const [applied, setApplied] = useState<Filters>(INITIAL);

  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: async () => (await api.get('/catalog/subjects')).data,
  });
  const { data: grades } = useQuery({
    queryKey: ['grades'],
    queryFn: async () => (await api.get('/catalog/grades')).data,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['teachers', applied],
    queryFn: async () =>
      (
        await api.get('/teachers', {
          params: {
            q: applied.q || undefined,
            subjectId: applied.subjectId || undefined,
            gradeId: applied.gradeId || undefined,
            language: applied.language || undefined,
            priceMinCents: applied.priceMin ? Number(applied.priceMin) * 100 : undefined,
            priceMaxCents: applied.priceMax ? Number(applied.priceMax) * 100 : undefined,
            sort: applied.sort,
            page: applied.page,
            pageSize: 9,
          },
        })
      ).data,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  function apply(extra?: Partial<Filters>) {
    setApplied({ ...draft, page: 1, ...extra });
  }

  return (
    <div className="mx-auto max-w-container px-8 py-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-4xl font-extrabold">{t('discovery.title')}</h1>
          <p className="mt-2 text-on-surface-variant">{t('discovery.subtitle')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          {t('discovery.sortBy')}
          <select
            className="input w-auto py-2"
            value={draft.sort}
            onChange={(e) => {
              setDraft({ ...draft, sort: e.target.value });
              apply({ sort: e.target.value });
            }}
          >
            {['rating', 'priceAsc', 'priceDesc', 'newest'].map((s) => (
              <option key={s} value={s}>
                {t(`discovery.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Filter panel — inline-start column (right side in RTL) */}
        <aside className="card h-fit w-full shrink-0 lg:w-72">
          <div className="mb-4 flex items-center justify-between border-b border-outline-variant/50 pb-3">
            <h2 className="font-heading text-xl font-bold">{t('discovery.filters')}</h2>
            <button
              className="text-sm text-primary hover:underline"
              onClick={() => {
                setDraft(INITIAL);
                setApplied(INITIAL);
              }}
            >
              {t('discovery.clearAll')}
            </button>
          </div>

          <input
            className="input mb-4"
            placeholder={t('discovery.searchPlaceholder')}
            value={draft.q}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />

          <p className="mb-2 text-sm font-bold">{t('discovery.subject')}</p>
          <div className="mb-4 space-y-2">
            {(subjects ?? []).map((s: any) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={draft.subjectId === s.id}
                  onChange={() =>
                    setDraft({ ...draft, subjectId: draft.subjectId === s.id ? '' : s.id })
                  }
                />
                {ar ? s.nameAr : s.nameEn}
              </label>
            ))}
          </div>

          <p className="mb-2 text-sm font-bold">{t('discovery.grade')}</p>
          <select
            className="input mb-4 py-2"
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
            className="input mb-4 py-2"
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
              className="input py-2"
              inputMode="numeric"
              placeholder={t('discovery.min')}
              value={draft.priceMin}
              onChange={(e) => setDraft({ ...draft, priceMin: e.target.value.replace(/\D/g, '') })}
            />
            <span className="text-outline">-</span>
            <input
              className="input py-2"
              inputMode="numeric"
              placeholder={t('discovery.max')}
              value={draft.priceMax}
              onChange={(e) => setDraft({ ...draft, priceMax: e.target.value.replace(/\D/g, '') })}
            />
          </div>

          <button className="btn-primary w-full" onClick={() => apply()}>
            {t('discovery.apply')}
          </button>
        </aside>

        {/* Results */}
        <section className="min-w-0 flex-1">
          {isLoading ? (
            <Spinner />
          ) : !data?.items.length ? (
            <EmptyState icon="search_off" title={t('discovery.noResults')} hint={t('discovery.noResultsHint')} />
          ) : (
            <>
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {data.items.map((tc: any) => (
                  <article key={tc.id} className="card flex flex-col p-5">
                    <div className="mb-3 flex items-start gap-3">
                      {tc.avatarUrl ? (
                        <img src={tc.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
                      ) : (
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed font-heading text-xl font-bold text-primary">
                          {tc.fullName?.trim()?.charAt(0)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <h3 className="truncate font-heading text-lg font-bold">{tc.fullName}</h3>
                        <p className="truncate text-sm text-primary">
                          {tc.subject ? (ar ? tc.subject.nameAr : tc.subject.nameEn) : '—'}
                          {tc.grades?.length
                            ? ` - ${ar ? tc.grades[0].nameAr : tc.grades[0].nameEn}`
                            : ''}
                        </p>
                      </div>
                    </div>
                    <div className="mb-2 flex items-center gap-2">
                      {tc.verified && (
                        <Badge tone="teal">
                          <span className="material-symbols-outlined text-sm">verified</span>
                          {t('discovery.verified')}
                        </Badge>
                      )}
                      <Stars rating={tc.avgRating} />
                      <span className="text-xs text-outline">
                        {t('discovery.reviewsCount', { count: tc.reviewsCount })}
                      </span>
                    </div>
                    <p className="mb-4 line-clamp-2 flex-1 text-sm text-on-surface-variant">{tc.bio}</p>
                    <div className="flex items-center justify-between border-t border-outline-variant/50 pt-4">
                      <div>
                        <p className="text-xs text-outline">{t('discovery.startingFrom')}</p>
                        <p className="font-heading text-2xl font-extrabold">{egp(tc.minPriceCents)}</p>
                      </div>
                      <Link to={`/t/${tc.slug}`} className="btn-ghost px-4 py-2 text-sm">
                        {t('discovery.viewProfile')}
                      </Link>
                    </div>
                  </article>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={`h-10 w-10 rounded-full font-bold transition ${
                        p === applied.page
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
                      }`}
                      onClick={() => setApplied({ ...applied, page: p })}
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
