import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { imageToDataUrl } from '../lib/image';
import { ErrorNote, Field, Modal } from './ui';

const METHOD_ICON: Record<string, string> = {
  INSTAPAY: 'account_balance', VODAFONE_CASH: 'smartphone', BANK_TRANSFER: 'account_balance', OTHER: 'payments',
};

/** Add funds to the student wallet by transfer + proof (mirrors PaymentModal). */
export default function WalletTopupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState('');
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

  const amountCents = Math.round(parseFloat(amount || '0') * 100);
  /**
   * Which identifier this method's SMS will carry, and whether what the student
   * typed could be it. Kept in step with the server's rule in
   * payer-reference.ts, which is the authority — this is so a wrong number is
   * caught while they are still looking at it. A top-up is the same transfer as
   * a course payment with no course attached, and is matched the same way, so it
   * asks for the same thing.
   */
  const refKind = method === 'VODAFONE_CASH' ? 'WALLET_NUMBER' : 'TRANSACTION_REFERENCE';
  const referenceLooksRight =
    refKind === 'WALLET_NUMBER'
      ? /^(?:\+?20|0)?1[0125]\d{8}$/.test(reference.replace(/[^\d]/g, ''))
      : reference.replace(/[^0-9a-z]/gi, '').length >= 4;
  const valid = amountCents >= 1000 && !!method && !!proof && referenceLooksRight;

  const submit = useMutation({
    mutationFn: async () =>
      (await api.post('/wallet/topups', {
        amountCents,
        method,
        proofImageUrl: proof,
        reference: reference.trim() || undefined,
      })).data,
    onSuccess: () => {
      setDone(true);
      qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  async function pickProof(file: File) {
    setProofName(file.name);
    setProof(await imageToDataUrl(file, { maxW: 900, maxH: 1400, quality: 0.7 }));
  }

  function close() {
    // Reset so re-opening starts clean.
    setDone(false); setAmount(''); setMethod(''); setReference(''); setProof(null); setProofName('');
    onClose();
  }

  return (
    <Modal open={open} onClose={close} title={t('walletStudent.topupTitle')} wide>
      {done ? (
        <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
          <span className="material-symbols-outlined mb-2 text-5xl text-secondary">hourglass_top</span>
          <p className="font-heading text-lg font-bold">{t('walletStudent.submittedTitle')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('walletStudent.submittedBody')}</p>
          <button className="btn-primary mt-5" onClick={close}>{t('common.back')}</button>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Where to send */}
          <div>
            <p className="mb-2 flex items-center gap-2 font-heading font-bold">
              <span className="material-symbols-outlined text-primary rtl:-scale-x-100">north_east</span>
              {t('walletStudent.transferTo')}
            </p>
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

          {/* Amount + proof */}
          <div>
            <p className="mb-2 flex items-center gap-2 font-heading font-bold">
              <span className="material-symbols-outlined text-primary">receipt_long</span>
              {t('walletStudent.afterTransfer')}
            </p>
            <Field label={t('walletStudent.amount')} hint={t('walletStudent.amountHint')}>
              <input
                className="input" dir="ltr" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="100"
              />
            </Field>
            <Field label={t('walletStudent.method')}>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">{t('walletStudent.pickMethod')}</option>
                <option value="INSTAPAY">{t('method.INSTAPAY')}</option>
                <option value="VODAFONE_CASH">{t('method.VODAFONE_CASH')}</option>
                <option value="BANK_TRANSFER">{t('method.BANK_TRANSFER')}</option>
                <option value="OTHER">{t('method.OTHER')}</option>
              </select>
            </Field>
            {method && (
              <Field label={t(`pay.ref.${refKind}`)} hint={t(`pay.ref.${refKind}Hint`)}>
                <input className="input" dir="ltr" inputMode={refKind === 'WALLET_NUMBER' ? 'tel' : 'text'}
                  value={reference} onChange={(e) => setReference(e.target.value)}
                  placeholder={refKind === 'WALLET_NUMBER' ? '01xxxxxxxxx' : '05b6efa4'} />
              </Field>
            )}
            <Field label={t('walletStudent.proof')}>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => e.target.files?.[0] && pickProof(e.target.files[0])} />
              <button type="button"
                className={`flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed py-4 text-sm font-bold transition ${proof ? 'border-secondary text-secondary' : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary'}`}
                onClick={() => fileRef.current?.click()}>
                <span className="material-symbols-outlined">{proof ? 'check_circle' : 'upload'}</span>
                {proof ? (proofName || t('walletStudent.proofPicked')) : t('walletStudent.uploadProof')}
              </button>
            </Field>
            {proof && <img src={proof} alt="" className="mb-3 max-h-40 rounded-lg border border-outline-variant/50 object-contain" />}
            <ErrorNote error={submit.error} />
            <button className="btn-primary w-full" disabled={submit.isPending || !valid} onClick={() => submit.mutate()}>
              {submit.isPending ? t('common.saving') : t('walletStudent.submit')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
