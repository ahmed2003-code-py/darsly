import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { Badge, CardGridSkeleton, EmptyState, ErrorNote, Modal, PageHeader } from '../../components/ui';

const METHOD_LABEL: Record<string, string> = {
  INSTAPAY: 'إنستاباي', VODAFONE_CASH: 'فودافون كاش', BANK_TRANSFER: 'تحويل بنكي', OTHER: 'أخرى',
};
const STATUS_TONE: Record<string, 'warn' | 'teal' | 'error'> = { PENDING: 'warn', PAID: 'teal', REJECTED: 'error' };

export default function TeacherPaymentsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING');
  const [proof, setProof] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['teacher-payments', status],
    queryFn: async () => (await api.get(`/teacher/payments?status=${status}`)).data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['teacher-payments'] });
    qc.invalidateQueries({ queryKey: ['teacher-wallet'] });
    qc.invalidateQueries({ queryKey: ['teacher-enrollments'] });
  };
  const verify = useMutation({
    mutationFn: async (id: string) => (await api.post(`/teacher/payments/${id}/verify`)).data,
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: async () => (await api.post(`/teacher/payments/${rejectId}/reject`, { reason: reason.trim() || undefined })).data,
    onSuccess: () => { setRejectId(null); setReason(''); invalidate(); },
  });

  return (
    <div className="mx-auto max-w-container px-6 py-8 sm:px-8">
      <PageHeader title={t('tpay.title')} subtitle={t('tpay.subtitle')} />

      {/* Status tabs */}
      <div className="mb-5 flex gap-1 rounded-2xl bg-surface-container-low p-1 sm:w-fit">
        {['PENDING', 'PAID', 'REJECTED'].map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-xl px-4 py-2 text-sm font-bold transition ${status === s ? 'bg-primary text-on-primary shadow' : 'text-on-surface-variant hover:text-primary'}`}>
            {t(`tpay.status.${s}`)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <CardGridSkeleton count={3} />
      ) : !data?.length ? (
        <EmptyState icon="receipt_long" title={t('tpay.empty')} hint={t('tpay.emptyHint')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((p: any) => (
            <div key={p.id} className="card flex gap-4">
              {p.proofImageUrl && (
                <button className="h-24 w-20 shrink-0 overflow-hidden rounded-lg border border-outline-variant/50" onClick={() => setProof(p.proofImageUrl)}>
                  <img src={p.proofImageUrl} alt="" className="h-full w-full object-cover" />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-bold">{p.studentName}</p>
                  <Badge tone={STATUS_TONE[p.status]}>{t(`tpay.status.${p.status}`)}</Badge>
                </div>
                <p className="truncate text-sm text-on-surface-variant">{p.courseTitle}</p>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-outline">
                  <span className="font-heading font-extrabold text-primary">{egp(p.amountCents)}</span>
                  <span>{METHOD_LABEL[p.method] ?? p.method}</span>
                  {p.reference && <span dir="ltr">#{p.reference}</span>}
                </div>
                {p.rejectedReason && <p className="mt-1 text-xs text-error">{p.rejectedReason}</p>}
                {p.status === 'PENDING' && (
                  <div className="mt-3 flex gap-2">
                    <button className="btn-primary flex-1 py-2 text-sm" disabled={verify.isPending} onClick={() => verify.mutate(p.id)}>
                      <span className="material-symbols-outlined text-base">check</span>{t('tpay.verify')}
                    </button>
                    <button className="btn-ghost px-4 py-2 text-sm text-error" onClick={() => setRejectId(p.id)}>{t('tpay.reject')}</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <ErrorNote error={verify.error} />

      {/* Proof lightbox */}
      <Modal open={!!proof} onClose={() => setProof(null)} title={t('tpay.proof')} wide>
        {proof && <img src={proof} alt="" className="mx-auto max-h-[70vh] rounded-lg" />}
      </Modal>

      {/* Reject reason */}
      <Modal open={!!rejectId} onClose={() => setRejectId(null)} title={t('tpay.rejectTitle')}>
        <textarea className="input min-h-24" dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('tpay.reasonPlaceholder')} />
        <div className="mt-4 flex gap-2">
          <button className="btn-primary flex-1" disabled={reject.isPending} onClick={() => reject.mutate()}>{t('tpay.confirmReject')}</button>
          <button className="btn-ghost" onClick={() => setRejectId(null)}>{t('common.cancel')}</button>
        </div>
      </Modal>
    </div>
  );
}
