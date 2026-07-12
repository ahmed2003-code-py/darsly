import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { imageToDataUrl } from '../lib/image';
import { egp } from '../lib/format';
import { ErrorNote, Field, Modal } from './ui';

const METHOD_ICON: Record<string, string> = {
  INSTAPAY: 'account_balance', VODAFONE_CASH: 'smartphone', BANK_TRANSFER: 'account_balance', OTHER: 'payments',
};

export default function PaymentModal({
  open, onClose, courseId, amountCents, couponCode,
}: { open: boolean; onClose: () => void; courseId: string; amountCents: number; couponCode?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [proofName, setProofName] = useState('');
  const [done, setDone] = useState(false);

  const { data: accounts } = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: async () => (await api.get('/payment-accounts')).data,
    enabled: open,
  });

  // Transparent breakdown: course price + platform service fee = total the
  // student pays. Fetched here so the amount is always authoritative.
  const { data: quote } = useQuery({
    queryKey: ['enroll-quote', courseId, couponCode],
    queryFn: async () => (await api.post('/enrollments/quote', { courseId, couponCode })).data,
    enabled: open,
  });
  const total = quote?.totalCents ?? amountCents;

  const submit = useMutation({
    mutationFn: async () =>
      (await api.post('/payments', { courseId, method, proofImageUrl: proof, reference: reference.trim() || undefined, couponCode })).data,
    onSuccess: () => {
      setDone(true);
      qc.invalidateQueries({ queryKey: ['course', courseId] });
      qc.invalidateQueries({ queryKey: ['my-enrollments'] });
      qc.invalidateQueries({ queryKey: ['my-payments'] });
    },
  });

  async function pickProof(file: File) {
    setProofName(file.name);
    setProof(await imageToDataUrl(file, { maxW: 900, maxH: 1400, quality: 0.7 }));
  }

  return (
    <Modal open={open} onClose={onClose} title={t('pay.title')} wide>
      {done ? (
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">hourglass_top</span>
          <p className="font-heading text-lg font-bold">{t('pay.submittedTitle')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('pay.submittedBody')}</p>
          <button className="btn-primary mt-5" onClick={onClose}>{t('common.back')}</button>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Where to send */}
          <div>
            <p className="mb-2 flex items-center gap-2 font-heading font-bold">
              <span className="material-symbols-outlined text-primary">north_east</span>{t('pay.transferTo')}
            </p>
            <div className="mb-3 rounded-xl bg-primary-fixed/40 p-3">
              {quote && (
                <div className="mb-2 space-y-1 border-b border-outline-variant pb-2 text-sm">
                  <div className="flex justify-between text-on-surface-variant">
                    <span>{t('pay.coursePrice', 'سعر الكورس')}</span>
                    <span className="tabular-nums">{egp(quote.netCents ?? quote.basePriceCents)}</span>
                  </div>
                  {quote.feeCents > 0 && (
                    <div className="flex justify-between text-on-surface-variant">
                      <span>{t('pay.serviceFee', 'رسوم خدمة المنصّة')}</span>
                      <span className="tabular-nums">{egp(quote.feeCents)}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-outline">{t('pay.amountDue')}</span>
                <span className="font-heading text-2xl font-bold tracking-tight text-primary tabular-nums">{egp(total)}</span>
              </div>
            </div>
            <div className="space-y-2">
              {(accounts ?? []).map((a: any) => (
                <div key={a.id} className="rounded-xl border border-outline-variant/60 p-3">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">{METHOD_ICON[a.method] ?? 'payments'}</span>
                    <span className="font-bold">{a.label}</span>
                  </div>
                  <p className="mt-1 select-all font-mono text-sm text-on-surface-variant" dir="ltr">{a.handle}</p>
                  {a.instructions && <p className="mt-1 text-xs text-outline">{a.instructions}</p>}
                </div>
              ))}
              {accounts && accounts.length === 0 && <p className="text-sm text-outline">{t('pay.noAccounts')}</p>}
            </div>
          </div>

          {/* Proof form */}
          <div>
            <p className="mb-2 flex items-center gap-2 font-heading font-bold">
              <span className="material-symbols-outlined text-primary">receipt_long</span>{t('pay.afterTransfer')}
            </p>
            <Field label={t('pay.method')}>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">{t('pay.pickMethod')}</option>
                <option value="INSTAPAY">إنستاباي</option>
                <option value="VODAFONE_CASH">فودافون كاش</option>
                <option value="BANK_TRANSFER">تحويل بنكي</option>
                <option value="OTHER">أخرى</option>
              </select>
            </Field>
            <Field label={t('pay.reference')} hint={t('pay.referenceHint')}>
              <input className="input" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TXN / 010…" />
            </Field>
            <Field label={t('pay.proof')}>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => e.target.files?.[0] && pickProof(e.target.files[0])} />
              <button type="button"
                className={`flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed py-4 text-sm font-bold transition ${proof ? 'border-secondary text-secondary' : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary'}`}
                onClick={() => fileRef.current?.click()}>
                <span className="material-symbols-outlined">{proof ? 'check_circle' : 'upload'}</span>
                {proof ? (proofName || t('pay.proofPicked')) : t('pay.uploadProof')}
              </button>
            </Field>
            {proof && <img src={proof} alt="" className="mb-3 max-h-40 rounded-lg border border-outline-variant/50 object-contain" />}
            <ErrorNote error={submit.error} />
            <button className="btn-primary w-full" disabled={submit.isPending || !method || !proof} onClick={() => submit.mutate()}>
              {submit.isPending ? t('common.saving') : t('pay.submit')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
