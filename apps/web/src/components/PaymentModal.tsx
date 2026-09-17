import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { imageToDataUrl } from '../lib/image';
import { egp } from '../lib/format';
import { ErrorNote, Field, Modal } from './ui';

/** The structured part of a rejected payment, when the server sent one. */
function faultOf(err: unknown): { code?: string; balanceCents?: number; requiredCents?: number } | null {
  return (err as { response?: { data?: { code?: string } } } | null)?.response?.data ?? null;
}

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
  // Off by default, every time the modal opens — a balance is the student's
  // money, and spending any of it toward this purchase is their call to make
  // each time, not something the platform decides for them because it happens
  // to be sitting there.
  const [useWallet, setUseWallet] = useState(false);
  /**
   * "I have already transferred the money."
   *
   * The form used to be openable and sendable before any money moved, and the
   * reference was optional — so a student could submit, in good faith, a
   * request with nothing behind it and nothing to match it to, and it landed in
   * an admin's queue as indistinguishable from a real one. Saying it out loud
   * is the difference between a payment and an intention.
   */
  const [transferred, setTransferred] = useState(false);

  /**
   * Which identifier this method's SMS will actually carry.
   *
   * Kept in step with the server's rule in payer-reference.ts, which remains
   * the authority — this exists so the student learns the number is wrong while
   * they are still looking at it, instead of from a rejection afterwards.
   */
  const refKind = method === 'VODAFONE_CASH' ? 'WALLET_NUMBER' : 'TRANSACTION_REFERENCE';
  /**
   * Only Vodafone Cash can be asked for an identifier — the same rule the
   * wallet top-up follows, and the same reason.
   *
   * InstaPay and bank transfers give the two sides different reference numbers:
   * the student's receipt says «المرجع 770916345902» and the SMS the platform
   * receives says «برقم مرجعي 3979e788». Asking for one here while the wallet
   * asked for nothing made the same transfer behave two different ways
   * depending on which screen it was started from. The receipt identifies these
   * — the amount and the minute it was sent — and it is uploaded either way.
   */
  const refRequired = method === 'VODAFONE_CASH';
  const referenceLooksRight =
    refKind === 'WALLET_NUMBER'
      ? /^(?:\+?20|0)?1[0125]\d{8}$/.test(reference.replace(/[^\d]/g, ''))
      : reference.replace(/[^0-9a-z]/gi, '').length >= 4;

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

  // What the student already has on the platform. A balance that covers the
  // total turns the whole transfer-and-wait dance into one button.
  const { data: wallet } = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => (await api.get('/wallet')).data,
    enabled: open,
  });
  const balance = wallet?.balanceCents ?? 0;
  // What the checkbox below actually authorises — zero unless the student has
  // ticked it, and never more than the price itself.
  const walletApplied = useWallet ? Math.min(balance, total) : 0;
  const cashDue = total - walletApplied;

  // A second click must not become a second purchase. React only repaints the
  // disabled state on the next frame, so a fast double-click gets two calls
  // through — the first buys the course, the second is refused for a balance
  // the first one just spent.
  const buying = useRef(false);
  const payWithWallet = useMutation({
    mutationFn: async () => (await api.post('/payments/from-wallet', { courseId, couponCode })).data,
    onSuccess: () => {
      // Paid and enrolled in one step — there is nothing pending to wait for,
      // so the course page should already show it unlocked behind this modal.
      qc.invalidateQueries({ queryKey: ['course', courseId] });
      qc.invalidateQueries({ queryKey: ['my-enrollments'] });
      qc.invalidateQueries({ queryKey: ['wallet'] });
      onClose();
    },
    onError: (err) => {
      // Already owning the course is not a failure worth arguing with: the
      // student wanted in, and they are in. This is what a double-click looks
      // like from the second request's side, so treat it as the success it
      // already was and let the unlocked page say so.
      if (faultOf(err)?.code === 'ALREADY_ENROLLED') {
        qc.invalidateQueries({ queryKey: ['course', courseId] });
        qc.invalidateQueries({ queryKey: ['my-enrollments'] });
        onClose();
      }
    },
    onSettled: () => {
      buying.current = false;
      // Whatever happened, the balance on screen is now a guess. Re-read it so
      // the next attempt is argued from the real number.
      qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const fault = faultOf(payWithWallet.error);

  const submit = useMutation({
    mutationFn: async () =>
      (await api.post('/payments', {
        courseId, method, proofImageUrl: proof, reference: reference.trim() || undefined, couponCode, useWallet,
      })).data,
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
        <>
        {/* A balance is the student's money — it goes toward this purchase
            only if they tick this, never because it happens to be sitting
            there or happens to cover the price. Unticked is the default and
            changes nothing below. */}
        {balance > 0 && (
          <div className="mb-5 rounded-2xl border border-outline-variant/60 p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={useWallet}
                onChange={(e) => setUseWallet(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
                  <span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>
                </span>
                <span>
                  <span className="block font-heading font-bold">{t('pay.useWalletToggle')}</span>
                  <span className="block text-xs text-on-surface-variant">
                    {t('pay.walletBalance', { amount: egp(balance) })}
                  </span>
                </span>
              </span>
            </label>

            {useWallet && cashDue === 0 && (
              <div className="mt-3 border-t border-outline-variant/40 pt-3">
                <button
                  className="btn-primary w-full"
                  disabled={payWithWallet.isPending}
                  onClick={() => {
                    if (buying.current || payWithWallet.isPending) return;
                    buying.current = true;
                    payWithWallet.mutate();
                  }}
                >
                  {payWithWallet.isPending ? t('common.saving') : t('pay.payNow', { amount: egp(total) })}
                </button>
                {fault?.code === 'INSUFFICIENT_BALANCE' ? (
                  // The server knows the real balance; the screen was showing a
                  // number from before this purchase started. Saying only "not
                  // enough" next to a balance that covers the price reads as the
                  // platform contradicting itself.
                  <p className="mt-3 rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
                    {t('pay.shortBalance', {
                      balance: egp(fault.balanceCents ?? 0),
                      required: egp(fault.requiredCents ?? total),
                    })}
                  </p>
                ) : (
                  <ErrorNote error={payWithWallet.error} />
                )}
                <p className="mt-2 text-xs text-outline">{t('pay.walletInstant')}</p>
              </div>
            )}
          </div>
        )}
        {/* Once the checkbox above covers the whole price, a transfer form
            asking for proof of a 0 ج.م transfer is pure confusion, not a
            second option — nothing here is worth showing. Unticked, or
            ticked but only partial, the form is exactly what it always was. */}
        {cashDue > 0 && (
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Where to send */}
          <div>
            <p className="mb-2 flex items-center gap-2 font-heading font-bold">
              <span className="material-symbols-outlined text-primary rtl:-scale-x-100">north_east</span>{t('pay.transferTo')}
            </p>
            <div className="mb-3 rounded-xl bg-primary-fixed/40 p-3">
              {/* One price. The platform fee is already inside it — a student is
                  buying a course, not paying two parties, and the split is not
                  theirs to see. A coupon discount IS shown: they earned it. */}
              {((quote && quote.discountCents > 0) || walletApplied > 0) && (
                <div className="mb-2 space-y-1 border-b border-outline-variant pb-2 text-sm">
                  {quote && quote.discountCents > 0 && (
                    <>
                      <div className="flex justify-between text-on-surface-variant">
                        <span>{t('pay.originalPrice')}</span>
                        <span className="tabular-nums line-through">{egp(quote.basePriceCents)}</span>
                      </div>
                      <div className="flex justify-between font-semibold text-primary">
                        <span>{t('pay.discount')}</span>
                        <span className="tabular-nums">−{egp(quote.discountCents)}</span>
                      </div>
                    </>
                  )}
                  {walletApplied > 0 && (
                    <div className="flex justify-between font-semibold text-primary">
                      <span>{t('pay.fromWalletLine')}</span>
                      <span className="tabular-nums">−{egp(walletApplied)}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-outline">
                  {walletApplied > 0 ? t('pay.amountDueAfterWallet') : t('pay.amountDue')}
                </span>
                <span className="font-heading text-2xl font-bold tracking-tight text-primary tabular-nums">
                  {egp(cashDue)}
                </span>
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

            {/* The order matters and used to be left to the student to infer:
                transfer, then tell us about it. A request submitted before the
                money moved has nothing to match and reaches an admin looking
                exactly like one that does. */}
            <label className={`mb-3 flex items-start gap-2 rounded-xl border p-3 text-sm transition ${
              transferred ? 'border-secondary bg-secondary-container/25' : 'border-outline-variant/60'
            }`}>
              <input type="checkbox" className="mt-0.5 accent-primary" checked={transferred}
                onChange={(e) => setTransferred(e.target.checked)} />
              <span>
                <span className="block font-bold">{t('pay.confirmTransferred')}</span>
                <span className="block text-xs text-on-surface-variant">{t('pay.confirmTransferredHint')}</span>
              </span>
            </label>

            <Field label={t('pay.method')}>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">{t('pay.pickMethod')}</option>
                <option value="INSTAPAY">{t('method.INSTAPAY')}</option><option value="VODAFONE_CASH">{t('method.VODAFONE_CASH')}</option><option value="BANK_TRANSFER">{t('method.BANK_TRANSFER')}</option><option value="OTHER">{t('method.OTHER')}</option>
              </select>
            </Field>

            {/* Which identifier is asked for is decided by the provider, not by
                us: a Vodafone Cash SMS names the sending wallet and carries no
                transaction id, a bank's names a reference and carries no phone
                number. Asking for the wrong one guarantees no match. */}
            {method && refRequired && (
              <Field label={t(`pay.ref.${refKind}`)} hint={t(`pay.ref.${refKind}Hint`)}>
                <input className="input" dir="ltr" inputMode={refKind === 'WALLET_NUMBER' ? 'tel' : 'text'}
                  value={reference} onChange={(e) => setReference(e.target.value)}
                  placeholder={refKind === 'WALLET_NUMBER' ? '01xxxxxxxxx' : '05b6efa4'} />
              </Field>
            )}
            {method && !refRequired && (
              <p className="mb-3 flex items-start gap-2 rounded-xl border border-outline-variant/60 bg-surface-container-low/60 p-3 text-xs leading-5 text-on-surface-variant">
                <span className="material-symbols-outlined text-[16px] leading-5 text-primary">auto_awesome</span>
                {t('walletStudent.receiptIsTheProof')}
              </p>
            )}
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
            <button className="btn-primary w-full"
              disabled={submit.isPending || !method || !proof || !transferred || (refRequired && !referenceLooksRight)}
              onClick={() => submit.mutate()}>
              {submit.isPending ? t('common.saving') : t('pay.submit')}
            </button>
          </div>
        </div>
        )}
        </>
      )}
    </Modal>
  );
}
