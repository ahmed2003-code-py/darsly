import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { ErrorNote } from '../ui';

export interface AdmissionView {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'USED';
  attempts: number;
}

/**
 * "الفصل مكتمل" → "طلب الانضمام": a student asks the teacher for a seat in a
 * full class. Approval of a free class books the seat; of a paid class it
 * only opens the ordinary checkout ("أكمل الحجز") — never a seat without
 * paying. The teacher's decision arrives live.
 */
export default function AdmissionRequest({
  sessionId,
  paid,
  onProceed,
  onSeated,
}: {
  sessionId: string;
  paid: boolean;
  /** Paid class, approved: open the ordinary checkout. */
  onProceed?: () => void;
  /** Free class, approved: the seat exists now (refresh the page's data). */
  onSeated?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ['live-admission', sessionId];
  const mine = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await api.get(`/live/${sessionId}/admission`)).data as AdmissionView | null,
  });
  const ask = useMutation({
    mutationFn: async () => (await api.post(`/live/${sessionId}/admission`)).data as AdmissionView,
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  const withdraw = useMutation({
    mutationFn: async () =>
      (await api.delete(`/live/${sessionId}/admission`)).data as AdmissionView | null,
    onSuccess: (d) => qc.setQueryData(key, d),
  });

  // The teacher's answer, as it happens.
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = (p: { sessionId: string; status: AdmissionView['status'] }) => {
      if (p?.sessionId !== sessionId) return;
      void qc.invalidateQueries({ queryKey: key });
      if (p.status === 'USED') onSeated?.();
    };
    sock.on('live:admission', on);
    return () => {
      sock.off('live:admission', on);
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = mine.data;
  const status = a?.status;
  const box = 'space-y-2 rounded-2xl border p-3 text-sm';

  if (status === 'PENDING')
    return (
      <div className={`${box} border-amber-500/40 bg-amber-500/10`} role="status">
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            hourglass_top
          </span>
          {t('admission.pending')}
        </p>
        <p className="text-on-surface-variant">{t('admission.pendingHint')}</p>
        <button
          type="button"
          className="text-xs font-semibold text-on-surface-variant hover:underline"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate()}
        >
          {t('admission.withdraw')}
        </button>
        <ErrorNote error={withdraw.error} />
      </div>
    );
  if (status === 'APPROVED' && paid)
    return (
      <div className={`${box} border-emerald-600/40 bg-emerald-600/10`} role="status">
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="material-symbols-outlined text-[18px] text-emerald-600">
            check_circle
          </span>
          {t('admission.approvedPaid')}
        </p>
        <p className="text-on-surface-variant">{t('admission.approvedPaidHint')}</p>
        <button type="button" className="btn-primary w-full" onClick={onProceed}>
          <span aria-hidden className="material-symbols-outlined text-base">
            shopping_cart
          </span>
          {t('admission.completeBooking')}
        </button>
      </div>
    );

  return (
    <div className={`${box} border-outline-variant`}>
      <p className="font-semibold text-error">{t('live.full')}</p>
      {status === 'REJECTED' && (
        <p className="text-on-surface-variant">{t('admission.rejected')}</p>
      )}
      {status === 'EXPIRED' ? (
        <p className="text-on-surface-variant">{t('admission.expired')}</p>
      ) : (
        <>
          <p className="text-on-surface-variant">{t('admission.hint')}</p>
          <button
            type="button"
            className="btn-secondary w-full justify-center"
            disabled={ask.isPending || mine.isLoading}
            onClick={() => ask.mutate()}
          >
            <span aria-hidden className="material-symbols-outlined text-base">
              person_add
            </span>
            {ask.isPending ? t('common.saving') : t('admission.ask')}
          </button>
        </>
      )}
      <ErrorNote error={ask.error} />
    </div>
  );
}
