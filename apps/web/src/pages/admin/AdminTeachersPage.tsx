import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';

const TABS = ['PENDING', 'APPROVED', 'ALL'] as const;
const TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral'> = {
  APPROVED: 'teal', PENDING: 'warn', REJECTED: 'error', SUSPENDED: 'neutral',
};

export default function AdminTeachersPage() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('status') ?? 'PENDING') as (typeof TABS)[number];

  const { data, isLoading } = useQuery({
    queryKey: ['admin-teachers', tab],
    queryFn: async () =>
      (await api.get('/admin/teachers', { params: tab === 'ALL' ? {} : { status: tab } })).data,
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      (await api.patch(`/admin/teachers/${id}/status`, { status })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teachers'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('admin.teachersTitle')} subtitle={t('admin.teachersSub')} />

      <div className="mb-6 flex gap-2">
        {TABS.map((tb) => (
          <button
            key={tb}
            className={`rounded-full px-5 py-2 font-heading text-sm font-bold transition ${
              tab === tb ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-low'
            }`}
            onClick={() => setParams(tb === 'ALL' ? {} : { status: tb })}
          >
            {tb === 'ALL' ? t('common.all') : t(`admin.status.${tb}`)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState icon="verified_user" title={t('admin.empty')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((tp: any) => (
            <article key={tp.id} className="card flex flex-col p-5">
              <div className="mb-3 flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-primary-fixed font-heading text-lg font-bold text-primary">
                  {tp.user.fullName?.trim()?.charAt(0)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-heading font-bold">{tp.user.fullName}</p>
                  <p className="truncate text-xs text-outline" dir="ltr">{tp.user.email ?? tp.user.phone}</p>
                </div>
                <Badge tone={TONE[tp.status]}>{t(`admin.status.${tp.status}`)}</Badge>
              </div>
              <p className="mb-3 line-clamp-2 flex-1 text-sm text-on-surface-variant">{tp.bio || '—'}</p>
              <p className="mb-4 flex items-center gap-3 text-xs text-outline">
                <span>{tp.subject ? (ar ? tp.subject.nameAr : tp.subject.nameEn) : '—'}</span>
                <span>· {t('admin.coursesCount', { count: tp._count.courses })}</span>
              </p>
              <div className="flex flex-wrap gap-2 border-t border-outline-variant/50 pt-4">
                {tp.status !== 'APPROVED' && (
                  <button className="btn-secondary flex-1 py-2 text-sm" disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: tp.id, status: 'APPROVED' })}>
                    {t('admin.approve')}
                  </button>
                )}
                {tp.status === 'PENDING' && (
                  <button className="rounded-lg border border-error/40 px-4 py-2 text-sm font-bold text-error hover:bg-error-container/40"
                    disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: tp.id, status: 'REJECTED' })}>
                    {t('admin.reject')}
                  </button>
                )}
                {tp.status === 'APPROVED' && (
                  <button className="rounded-lg border border-outline px-4 py-2 text-sm font-bold text-on-surface-variant hover:bg-surface-container-low"
                    disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: tp.id, status: 'SUSPENDED' })}>
                    {t('admin.suspend')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
