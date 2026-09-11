import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { paymentMethodLabel } from '../../lib/paymentMethods';
import { api } from '../../lib/api';
import { dateShort, egp } from '../../lib/format';
import { EmptyState, ErrorNote, Modal, PageHeader, Skeleton } from '../../components/ui';

interface TopupRow {
  id: string;
  amountCents: number;
  method: string;
  reference: string | null;
  proofImageUrl: string;
  status: string;
  createdAt: string;
  studentName: string;
  studentPhone: string | null;
}

export default function AdminWalletPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [proof, setProof] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery<TopupRow[]>({
    queryKey: ['admin-wallet-topups'],
    queryFn: async () => (await api.get('/admin/wallet/topups?status=PENDING')).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-wallet-topups'] });
  const approve = useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/wallet/topups/${id}/approve`)).data,
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/admin/wallet/topups/${id}/reject`, { reason: t('walletAdmin.rejectReason') })).data,
    onSuccess: invalidate,
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('walletAdmin.title')} subtitle={t('walletAdmin.subtitle')} />
      <ErrorNote error={approve.error || reject.error} />

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : !rows?.length ? (
        <EmptyState icon="account_balance_wallet" title={t('walletAdmin.none')} />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center gap-4">
              <button
                onClick={() => setProof(r.proofImageUrl)}
                className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-outline-variant/60"
                title={t('walletAdmin.proof')}
              >
                <img src={r.proofImageUrl} alt="" className="h-full w-full object-cover" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{r.studentName}</p>
                <p className="text-xs text-outline" dir="ltr">{r.studentPhone ?? ''}</p>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {paymentMethodLabel(r.method)}
                  {r.reference ? ` · ${r.reference}` : ''} · {dateShort(r.createdAt)}
                </p>
              </div>
              <span className="font-heading text-xl font-extrabold text-primary tabular-nums" dir="ltr">
                {egp(r.amountCents)}
              </span>
              <div className="flex gap-2">
                <button className="btn-ghost" disabled={reject.isPending} onClick={() => reject.mutate(r.id)}>
                  {t('walletAdmin.reject')}
                </button>
                <button className="btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
                  <span className="material-symbols-outlined text-[20px]">check_circle</span>
                  {t('walletAdmin.approve')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!proof} onClose={() => setProof(null)} title={t('walletAdmin.proof')} wide>
        {proof && <img src={proof} alt="" className="mx-auto max-h-[70vh] rounded-lg object-contain" />}
      </Modal>
    </div>
  );
}
