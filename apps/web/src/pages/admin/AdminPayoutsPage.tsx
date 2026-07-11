import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';

const TONE: Record<string, 'teal' | 'warn' | 'error' | 'neutral' | 'primary'> = {
  COMPLETED: 'teal', REQUESTED: 'warn', APPROVED: 'primary', PROCESSING: 'primary', REJECTED: 'error',
};

export default function AdminPayoutsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-payouts'],
    queryFn: async () => (await api.get('/admin/payouts')).data,
  });

  const process = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      (await api.patch(`/admin/payouts/${id}`, { status })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-payouts'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('admin.payoutsTitle')} subtitle={t('admin.payoutsSub')} />

      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <EmptyState icon="payments" title={t('admin.empty')} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/40 text-on-surface-variant">
                <th className="px-6 py-4 text-start font-bold">{t('admin.colTeacher')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('admin.colAmount')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('admin.colMethod')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('admin.colStatus')}</th>
                <th className="px-6 py-4 text-start font-bold">{t('admin.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p: any) => (
                <tr key={p.id} className="border-b border-outline-variant/30 last:border-0">
                  <td className="px-6 py-4">
                    <p className="font-bold">{p.teacher.user.fullName}</p>
                    <p className="text-xs text-outline">{dateShort(p.createdAt)}</p>
                  </td>
                  <td className="px-6 py-4 font-heading font-bold">{egp(p.amountCents)}</td>
                  <td className="px-6 py-4">{t(`wallet.${p.method}`)}</td>
                  <td className="px-6 py-4"><Badge tone={TONE[p.status] ?? 'neutral'}>{t(`wallet.payoutStatus.${p.status}`)}</Badge></td>
                  <td className="px-6 py-4">
                    {!['COMPLETED', 'REJECTED'].includes(p.status) ? (
                      <div className="flex gap-2">
                        <button className="btn-secondary px-3 py-1.5 text-xs" disabled={process.isPending}
                          onClick={() => process.mutate({ id: p.id, status: 'COMPLETED' })}>
                          {t('admin.complete')}
                        </button>
                        <button className="rounded-lg border border-error/40 px-3 py-1.5 text-xs font-bold text-error hover:bg-error-container/40"
                          disabled={process.isPending} onClick={() => process.mutate({ id: p.id, status: 'REJECTED' })}>
                          {t('admin.reject')}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-outline">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
