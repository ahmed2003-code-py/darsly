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

const EG_MOBILE = /^(?:\+?20|0)?1[0125]\d{8}$/;
const tenDigits = (v: string) => v.replace(/\D/g, '').slice(-10);

export interface DeclareInput {
  method: string;
  source: 'WALLET' | 'BANK';
  senderWallet?: string;
  payerName?: string;
  reference?: string;
}

export interface ProofInput {
  proofImageUrl: string;
}

/** What the form needs of the purchase: its price and the payment declared for it. */
export interface TransferPurchase {
  studentPaysCents: number;
  payment?: {
    status: string;
    method: string;
    transferSource?: 'WALLET' | 'BANK' | null;
    senderWallet?: string | null;
    payerName?: string | null;
    claimedAt?: string | null;
  } | null;
}

/**
 * Paying for a live seat by transfer, in the order that lets it be verified.
 *
 * Step 1 — BEFORE any money moves — the buyer says where it comes from: their
 * own mobile wallet (its number), or a bank / InstaPay account (its holder's
 * name; there is no wallet number to give, and none is asked for). That writes
 * the pending payment on the server, so the transfer's SMS finds it waiting.
 *
 * Step 2 — only then — the exact amount and Darsly's account are shown, and
 * after transferring the buyer sends the receipt. The receipt helps a person
 * review; it never confirms anything by itself.
 */
export default function LiveTransferForm({
  purchase,
  onDeclare,
  declaring,
  declareError,
  onSubmitProof,
  pending,
  error,
}: {
  purchase: TransferPurchase;
  onDeclare: (input: DeclareInput) => void;
  declaring: boolean;
  declareError: unknown;
  onSubmitProof: (input: ProofInput) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const declared = purchase.payment?.status === 'PENDING' && !purchase.payment.claimedAt ? purchase.payment : null;
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState(declared?.method ?? '');
  const [source, setSource] = useState<'WALLET' | 'BANK' | ''>(declared?.transferSource ?? '');
  const [senderWallet, setSenderWallet] = useState(declared?.senderWallet ?? '');
  const [payerName, setPayerName] = useState(declared?.payerName ?? '');
  const [reference, setReference] = useState('');
  const [proof, setProof] = useState<string | null>(null);
  const [proofName, setProofName] = useState('');
  const [transferred, setTransferred] = useState(false);
  // A double click lands before React repaints the button disabled — one
  // guard per step, so declaring never swallows the proof click after it.
  const sending = useRef(false);
  const declaringNow = useRef(false);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['payment-accounts'],
    queryFn: async () => (await api.get('/payment-accounts')).data,
  });
  const list: any[] = accounts ?? [];
  const ours = (v: string) => !!tenDigits(v) && list.some((a) => tenDigits(a.handle) === tenDigits(v));

  // The same rules the server enforces, so a wrong answer is seen while it can be fixed.
  const walletDigits = senderWallet.replace(/\D/g, '');
  const walletIsOurs = source === 'WALLET' && walletDigits.length >= 10 && ours(senderWallet);
  const walletOk = EG_MOBILE.test(walletDigits) && !walletIsOurs;
  const nameOk = payerName.trim().split(/\s+/).filter(Boolean).length >= 2;
  const canDeclare = !!method && (source === 'WALLET' ? walletOk : source === 'BANK' ? nameOk : false);

  const account = list.find((a) => a.method === (declared?.method ?? method)) ?? null;
  const showStep2 = !!declared && !editing;
  const ready = !!proof && transferred;

  async function pickProof(file: File) {
    setProofName(file.name);
    setProof(await imageToDataUrl(file, { maxW: 900, maxH: 1400, quality: 0.7 }));
  }

  if (showStep2) {
    return (
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <p className="mb-2 flex items-center gap-2 font-heading font-bold">
            <span className="material-symbols-outlined text-primary rtl:-scale-x-100">north_east</span>
            {t('liveTransfer.step2Title')}
          </p>
          <div className="mb-3 flex items-center justify-between rounded-xl bg-primary-fixed/40 p-3">
            <span className="text-xs text-outline">{t('liveTransfer.sendExactly')}</span>
            <span className="font-heading text-2xl font-bold tracking-tight text-primary tabular-nums">
              {egp(purchase.studentPaysCents)}
            </span>
          </div>
          {account && (
            <div className="rounded-xl border border-outline-variant/60 p-3">
              <p className="text-xs text-outline">{t('liveTransfer.toAccount')}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">{METHOD_ICON[account.method] ?? 'payments'}</span>
                <span className="font-bold">{account.label}</span>
              </div>
              <p className="mt-1 select-all font-mono text-sm text-on-surface-variant" dir="ltr">
                {account.handle}
              </p>
              {account.instructions && <p className="mt-1 text-xs text-outline">{account.instructions}</p>}
            </div>
          )}
          <div className="mt-3 flex items-start justify-between gap-2 rounded-xl bg-surface-container-low/60 p-3 text-sm">
            <span>
              {declared.transferSource === 'WALLET'
                ? t('liveTransfer.fromWallet', { number: declared.senderWallet })
                : t('liveTransfer.fromBank', { name: declared.payerName })}
            </span>
            <button type="button" className="shrink-0 text-xs font-bold text-primary hover:underline" onClick={() => setEditing(true)}>
              {t('liveTransfer.edit')}
            </button>
          </div>
          <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-on-surface-variant">
            <span className="material-symbols-outlined text-[16px] leading-5 text-primary">verified</span>
            {t('liveTransfer.autoConfirm')}
          </p>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-2 font-heading font-bold">
            <span className="material-symbols-outlined text-primary">receipt_long</span>
            {t('liveTransfer.afterTransfer')}
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
            <span className="block font-bold">{t('pay.confirmTransferred')}</span>
          </label>
          <Field label={t('pay.proof')} hint={t('liveTransfer.proofNote')}>
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
            <img src={proof} alt="" className="mb-3 max-h-40 rounded-lg border border-outline-variant/50 object-contain" />
          )}
          <ErrorNote error={error} />
          <button
            className="btn-primary w-full"
            disabled={pending || !ready}
            aria-busy={pending || undefined}
            onClick={() => {
              if (sending.current || pending || !ready) return;
              sending.current = true;
              onSubmitProof({ proofImageUrl: proof as string });
              setTimeout(() => (sending.current = false), 1500);
            }}
          >
            {pending ? t('common.saving') : t('liveTransfer.submitProof')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canDeclare || declaring || declaringNow.current || !source) return;
        declaringNow.current = true;
        onDeclare(
          source === 'WALLET'
            ? { method, source, senderWallet: senderWallet.trim(), payerName: payerName.trim() || undefined }
            : { method, source, payerName: payerName.trim(), reference: reference.trim() || undefined },
        );
        setEditing(false);
        setTimeout(() => (declaringNow.current = false), 1500);
      }}
    >
      <div>
        <p className="font-heading font-bold">{t('liveTransfer.step1Title')}</p>
        <p className="text-sm text-on-surface-variant">{t('liveTransfer.step1Body')}</p>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('liveTransfer.destination')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {list.map((a) => (
            <label
              key={a.id}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm ${
                method === a.method ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/60'
              }`}
            >
              <input
                type="radio"
                name="live-transfer-destination"
                className="accent-primary"
                checked={method === a.method}
                onChange={() => setMethod(a.method)}
              />
              <span className="material-symbols-outlined text-primary">{METHOD_ICON[a.method] ?? 'payments'}</span>
              <span className="font-bold">{a.label}</span>
            </label>
          ))}
        </div>
        {!isLoading && list.length === 0 && <p className="text-sm text-outline">{t('pay.noAccounts')}</p>}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('liveTransfer.source')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['WALLET', 'BANK'] as const).map((s) => (
            <label
              key={s}
              className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm ${
                source === s ? 'border-primary bg-primary-fixed/30' : 'border-outline-variant/60'
              }`}
            >
              <input
                type="radio"
                name="live-transfer-source"
                className="mt-1 accent-primary"
                checked={source === s}
                onChange={() => setSource(s)}
              />
              <span>
                <span className="block font-bold">
                  {s === 'WALLET' ? t('liveTransfer.sourceWallet') : t('liveTransfer.sourceBank')}
                </span>
                <span className="block text-xs text-on-surface-variant">
                  {s === 'WALLET' ? t('liveTransfer.sourceWalletHint') : t('liveTransfer.sourceBankHint')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {source && (
        <p className="flex items-start gap-2 rounded-xl border border-outline-variant/60 bg-surface-container-low/60 p-3 text-xs leading-5 text-on-surface-variant">
          <span className="material-symbols-outlined text-[16px] leading-5 text-primary">info</span>
          {t('liveTransfer.notOurs')}
        </p>
      )}

      {source === 'WALLET' && (
        <Field label={t('liveTransfer.senderWallet')} id="live-transfer-wallet">
          <input
            id="live-transfer-wallet"
            className="input"
            dir="ltr"
            inputMode="tel"
            value={senderWallet}
            aria-invalid={!!senderWallet && !walletOk}
            onChange={(e) => setSenderWallet(e.target.value)}
            placeholder="01xxxxxxxxx"
          />
          {walletIsOurs ? (
            <p className="mt-1 text-xs text-error" role="alert">{t('liveTransfer.ownNumber')}</p>
          ) : (
            walletDigits.length >= 10 && !walletOk && (
              <p className="mt-1 text-xs text-error" role="alert">{t('liveTransfer.badWallet')}</p>
            )
          )}
        </Field>
      )}

      {source === 'BANK' && (
        <>
          <Field label={t('liveTransfer.payerName')} hint={t('liveTransfer.payerNameHint')} id="live-transfer-name">
            <input
              id="live-transfer-name"
              className="input"
              dir="auto"
              maxLength={80}
              value={payerName}
              aria-invalid={!!payerName && !nameOk}
              onChange={(e) => setPayerName(e.target.value)}
            />
          </Field>
          <Field label={t('liveTransfer.reference')} id="live-transfer-ref">
            <input
              id="live-transfer-ref"
              className="input"
              dir="ltr"
              maxLength={120}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </>
      )}

      <ErrorNote error={declareError} />
      <div className="flex gap-2">
        <button className="btn-primary flex-1" disabled={!canDeclare || declaring} aria-busy={declaring || undefined}>
          {declaring ? t('common.saving') : t('liveTransfer.continue')}
        </button>
        {declared && editing && (
          <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
