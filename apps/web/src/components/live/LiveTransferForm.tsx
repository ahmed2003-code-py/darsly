import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { imageToDataUrl } from '../../lib/image';
import { ErrorNote, Field } from '../ui';

const METHOD_ICON: Record<string, string> = {
  INSTAPAY: 'account_balance',
  VODAFONE_CASH: 'smartphone',
  BANK_TRANSFER: 'account_balance',
  OTHER: 'payments',
};

export interface TransferInput {
  method: string;
  reference?: string;
  proofImageUrl: string;
}

/**
 * Pay for a live seat by transfer: where to send it, exactly how much, and
 * the proof afterwards — for a student and a guest alike.
 *
 * The amount is the server's frozen price for this purchase; nothing typed
 * here changes it. Which identifier is asked for follows the same rule the
 * server enforces (a Vodafone Cash SMS names the sending wallet; a bank's
 * receipt is its own proof), so the buyer learns a wrong number while they
 * are still looking at it.
 */
export default function LiveTransferForm({
  amountCents,
  onSubmit,
  pending,
  error,
}: {
  amountCents: number;
  onSubmit: (input: TransferInput) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [proofName, setProofName] = useState('');
  const [transferred, setTransferred] = useState(false);
  // A double click lands before React repaints the button disabled.
  const sending = useRef(false);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: async () => (await api.get('/payment-accounts')).data,
  });

  const refRequired = method === 'VODAFONE_CASH';
  const referenceLooksRight = /^(?:\+?20|0)?1[0125]\d{8}$/.test(reference.replace(/[^\d]/g, ''));
  const ready = !!method && !!proof && transferred && (!refRequired || referenceLooksRight);

  async function pickProof(file: File) {
    setProofName(file.name);
    setProof(await imageToDataUrl(file, { maxW: 900, maxH: 1400, quality: 0.7 }));
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div>
        <p className="mb-2 flex items-center gap-2 font-heading font-bold">
          <span className="material-symbols-outlined text-primary rtl:-scale-x-100">
            north_east
          </span>
          {t('pay.transferTo')}
        </p>
        <div className="mb-3 flex items-center justify-between rounded-xl bg-primary-fixed/40 p-3">
          <span className="text-xs text-outline">{t('pay.amountDue')}</span>
          <span className="font-heading text-2xl font-bold tracking-tight text-primary tabular-nums">
            {egp(amountCents)}
          </span>
        </div>
        <div className="space-y-2">
          {(accounts ?? []).map((a: any) => (
            <div key={a.id} className="rounded-xl border border-outline-variant/60 p-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">
                  {METHOD_ICON[a.method] ?? 'payments'}
                </span>
                <span className="font-bold">{a.label}</span>
              </div>
              <p className="mt-1 select-all font-mono text-sm text-on-surface-variant" dir="ltr">
                {a.handle}
              </p>
              {a.instructions && <p className="mt-1 text-xs text-outline">{a.instructions}</p>}
            </div>
          ))}
          {!isLoading && accounts?.length === 0 && (
            <p className="text-sm text-outline">{t('pay.noAccounts')}</p>
          )}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-on-surface-variant">
          <span className="material-symbols-outlined text-[16px] leading-5 text-primary">
            verified
          </span>
          {t('liveBuy.autoConfirmHint')}
        </p>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-2 font-heading font-bold">
          <span className="material-symbols-outlined text-primary">receipt_long</span>
          {t('pay.afterTransfer')}
        </p>
        <label
          className={`mb-3 flex items-start gap-2 rounded-xl border p-3 text-sm transition ${
            transferred ? 'border-secondary bg-secondary-container/25' : 'border-outline-variant/60'
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={transferred}
            onChange={(e) => setTransferred(e.target.checked)}
          />
          <span>
            <span className="block font-bold">{t('pay.confirmTransferred')}</span>
            <span className="block text-xs text-on-surface-variant">
              {t('pay.confirmTransferredHint')}
            </span>
          </span>
        </label>
        <Field label={t('pay.method')} id="live-transfer-method">
          <select
            id="live-transfer-method"
            className="input"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="">{t('pay.pickMethod')}</option>
            <option value="INSTAPAY">{t('method.INSTAPAY')}</option>
            <option value="VODAFONE_CASH">{t('method.VODAFONE_CASH')}</option>
            <option value="BANK_TRANSFER">{t('method.BANK_TRANSFER')}</option>
            <option value="OTHER">{t('method.OTHER')}</option>
          </select>
        </Field>
        {refRequired && (
          <Field
            label={t('pay.ref.WALLET_NUMBER')}
            hint={t('pay.ref.WALLET_NUMBERHint')}
            id="live-transfer-ref"
          >
            <input
              id="live-transfer-ref"
              className="input"
              dir="ltr"
              inputMode="tel"
              value={reference}
              aria-invalid={!!reference && !referenceLooksRight}
              onChange={(e) => setReference(e.target.value)}
              placeholder="01xxxxxxxxx"
            />
          </Field>
        )}
        {method && !refRequired && (
          <p className="mb-3 flex items-start gap-2 rounded-xl border border-outline-variant/60 bg-surface-container-low/60 p-3 text-xs leading-5 text-on-surface-variant">
            <span className="material-symbols-outlined text-[16px] leading-5 text-primary">
              auto_awesome
            </span>
            {t('walletStudent.receiptIsTheProof')}
          </p>
        )}
        <Field label={t('pay.proof')}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && pickProof(e.target.files[0])}
          />
          <button
            type="button"
            className={`flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed py-4 text-sm font-bold transition ${
              proof
                ? 'border-secondary text-secondary'
                : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary'
            }`}
            onClick={() => fileRef.current?.click()}
          >
            <span className="material-symbols-outlined">{proof ? 'check_circle' : 'upload'}</span>
            {proof ? proofName || t('pay.proofPicked') : t('pay.uploadProof')}
          </button>
        </Field>
        {proof && (
          <img
            src={proof}
            alt=""
            className="mb-3 max-h-40 rounded-lg border border-outline-variant/50 object-contain"
          />
        )}
        <ErrorNote error={error} />
        <button
          className="btn-primary w-full"
          disabled={pending || !ready}
          aria-busy={pending || undefined}
          onClick={() => {
            if (sending.current || pending || !ready) return;
            sending.current = true;
            onSubmit({
              method,
              reference: reference.trim() || undefined,
              proofImageUrl: proof as string,
            });
            setTimeout(() => (sending.current = false), 1500);
          }}
        >
          {pending ? t('common.saving') : t('pay.submit')}
        </button>
      </div>
    </div>
  );
}
