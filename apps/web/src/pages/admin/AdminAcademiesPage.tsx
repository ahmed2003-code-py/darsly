import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { AcademyStatus } from '@darsly/shared-types';
import { egp } from '../../lib/format';
import { useAdminAcademies } from '../../lib/adminCommandCenter';
import { Badge, EmptyState, PageHeader, Skeleton } from '../../components/ui';

const STATUSES: AcademyStatus[] = [
  AcademyStatus.ACTIVE,
  AcademyStatus.PENDING,
  AcademyStatus.SUSPENDED,
  AcademyStatus.ARCHIVED,
];
const TONE: Record<AcademyStatus, 'teal' | 'warn' | 'error' | 'neutral'> = {
  [AcademyStatus.ACTIVE]: 'teal',
  [AcademyStatus.PENDING]: 'warn',
  [AcademyStatus.SUSPENDED]: 'error',
  [AcademyStatus.ARCHIVED]: 'neutral',
};

export default function AdminAcademiesPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as AcademyStatus | null) ?? '';
  const [searchInput, setSearchInput] = useState(params.get('search') ?? '');
  const search = params.get('search') ?? '';
  const page = Number(params.get('page') ?? '1');

  const { data, isLoading, isFetching } = useAdminAcademies({ search, status, page, pageSize: 20 });

  const setStatus = (s: AcademyStatus | '') => {
    const next = new URLSearchParams(params);
    if (s) next.set('status', s); else next.delete('status');
    next.delete('page');
    setParams(next);
  };
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    if (searchInput.trim()) next.set('search', searchInput.trim()); else next.delete('search');
    next.delete('page');
    setParams(next);
  };
  const goPage = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="page">
      <PageHeader title={t('admin.academiesTitle')} subtitle={t('admin.academiesSub')} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <form onSubmit={submitSearch} className="flex-1 min-w-[220px]">
          <div className="relative">
            <span className="material-symbols-outlined absolute start-3 top-1/2 -translate-y-1/2 text-xl text-outline">search</span>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('admin.academiesSearchPlaceholder')}
              className="w-full rounded-full border border-outline-variant bg-surface-container-lowest py-2.5 ps-11 pe-4 text-sm outline-none focus:border-primary"
            />
          </div>
        </form>
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-full px-4 py-2 font-heading text-sm font-bold transition ${
              !status ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setStatus('')}
          >
            {t('common.all')}
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              className={`rounded-full px-4 py-2 font-heading text-sm font-bold transition ${
                status === s ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
              }`}
              onClick={() => setStatus(s)}
            >
              {t(`admin.academyStatus.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : !data?.academies.length ? (
        <EmptyState icon="apartment" title={t('admin.academiesEmpty')} />
      ) : (
        <>
          <div className={`grid gap-4 md:grid-cols-2 xl:grid-cols-3 ${isFetching ? 'opacity-60' : ''}`}>
            {data.academies.map((a) => (
              <Link key={a.id} to={`/admin/academies/${a.id}`} className="card card-hover flex flex-col p-5">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-heading font-bold">{a.name}</p>
                    <p className="truncate text-xs text-outline" dir="ltr">{a.slug}</p>
                  </div>
                  <Badge tone={TONE[a.status]}>{t(`admin.academyStatus.${a.status}`)}</Badge>
                </div>
                <p className="mb-3 truncate text-sm text-on-surface-variant">{a.ownerName}</p>
                <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="font-heading text-lg font-extrabold tabular-nums">{a.teachersCount + a.assistantsCount}</p>
                    <p className="text-[11px] text-outline">{t('admin.staff')}</p>
                  </div>
                  <div>
                    <p className="font-heading text-lg font-extrabold tabular-nums">{a.studentsCount}</p>
                    <p className="text-[11px] text-outline">{t('admin.students')}</p>
                  </div>
                  <div>
                    <p className="font-heading text-lg font-extrabold tabular-nums">{a.publishedCoursesCount}</p>
                    <p className="text-[11px] text-outline">{t('admin.courses')}</p>
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between border-t border-outline-variant/50 pt-3 text-sm">
                  <span className="text-on-surface-variant">{t('admin.netRevenue')}</span>
                  <span className="font-heading font-bold tabular-nums">{egp(a.netRevenueCents)}</span>
                </div>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <button
                className="btn-secondary px-4 py-2 text-sm disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => goPage(page - 1)}
              >
                {t('common.prev')}
              </button>
              <span className="text-sm text-on-surface-variant tabular-nums">{t('admin.pageOf', { page, total: totalPages })}</span>
              <button
                className="btn-secondary px-4 py-2 text-sm disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => goPage(page + 1)}
              >
                {t('common.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
