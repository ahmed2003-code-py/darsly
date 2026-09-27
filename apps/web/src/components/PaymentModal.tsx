import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { egp } from '../lib/format';
import { backoffInterval } from '../lib/livePolling';
import LiveTransferForm, { type DeclareInput, type ProofInput } from './live/LiveTransferForm';
import PaymentStageNote from './payments/PaymentStageNote';
import { ErrorNote, Field, Modal, Spinner } from './ui';

/** The structured part of a rejected payment, when the server sent one. */
function faultOf(
  err: unknown,
): { code?: string; balanceCents?: number; requiredCents?: number } | null {
  return (err as { response?: { data?: { code?: string } } } | null)?.response?.data ?? null;
}

/** The server's view of this course's open transfer payment (see ManualPaymentsService.checkoutView). */
interface CourseCheckout {
  id: string;
  status: 'PENDING' | 'PAID' | 'REJECTED' | string;
  stage: 'AWAITING_TRANSFER' | 'PROOF_SENT' | 'UNDER_REVIEW' | 'CONFIRMED' | 'REJECTED' | string;
  amountCents: number;
  walletCents: number;
  dueCents: number;
  method: string;
  transferSource: 'WALLET' | 'BANK' | null;
  senderWallet: string | null;
  payerName: string | null;
  claimedAt: string | null;
  enrollmentStatus: string | null;
}

/**
 * Buying a course by transfer — the same flow as a paid Live seat.
 *
 * The student first says where the money comes from; that writes a PENDING
 * payment on the server, and only then are the exact amount and Darsly's
 * account shown. The transfer's SMS is matched against that payment by the
 * listener, and this modal watches it turn PAID by itself — no "I
 * transferred", no refresh, nobody at Darsly in the happy path. A receipt can
 * still be sent; it helps a person review and never confirms anything alone.
 *
 * Paying fully from the Darsly wallet, and cash handed to the teacher or
 * center, keep their own one-step paths.
 */
export default function PaymentModal({
  open,
  onClose,
  courseId,
  amountCents,
  couponCode,
}: {
  open: boolean;
  onClose: () => void;
  courseId: string;
  amountCents: number;
  couponCode?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // Phase 7: "I paid cash" — a claim, not a receipt. Who the money was handed
  // to (a Center course may offer its own desk; every course offers its teacher).
  const [cash, setCash] = useState(false);
  const [cashReceiver, setCashReceiver] = useState<'TEACHER' | 'CENTER'>('TEACHER');
  const [cashNote, setCashNote] = useState('');
  const [cashDone, setCashDone] = useState(false);
  // Off by default, every time the modal opens — a balance is the student's
  // money, and spending any of it toward this purchase is their call to make
  // each time, not something the platform decides for them.
  const [useWallet, setUseWallet] = useState(false);

  // Quick polling right after a change, backing off the longer nothing happens.
  const since = useRef(Date.now());
  const lastState = useRef<string | null>(null);
  const checkoutKey = ['course-checkout', courseId];
  const checkout = useQuery({
    queryKey: checkoutKey,
    queryFn: async (): Promise<CourseCheckout | null> => {
      const data = (await api.get(`/payments/for-course/${courseId}`)).data || null;
      const key = data ? `${data.status}:${data.stage}` : 'none';
      if (key !== lastState.current) {
        lastState.current = key;
        since.current = Date.now();
      }
      return data;
    },
    enabled: open,
    refetchInterval: (q) =>
      q.state.data?.status === 'PENDING' ? backoffInterval(since.current) : false,
  });
  const view = checkout.data ?? null;

  // Transparent breakdown, from the server: price, coupon, total.
  const { data: quote } = useQuery({
    queryKey: ['enroll-quote', courseId, couponCode],
    queryFn: async () => (await api.post('/enrollments/quote', { courseId, couponCode })).data,
    enabled: open,
  });
  const total = quote?.totalCents ?? amountCents;

  const { data: wallet } = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => (await api.get('/wallet')).data,
    enabled: open,
  });
  const balance = wallet?.balanceCents ?? 0;
  const walletApplied = useWallet ? Math.min(balance, total) : 0;
  const cashDue = total - walletApplied;

  const unlocked = () => {
    qc.invalidateQueries({ queryKey: ['course', courseId] });
    qc.invalidateQueries({ queryKey: ['my-enrollments'] });
    qc.invalidateQueries({ queryKey: ['my-payments'] });
    qc.invalidateQueries({ queryKey: ['wallet'] });
  };
  // Confirmed while the modal was open (the listener, or a reviewer): the
  // course behind it unlocks at the same moment.
  const paid = view?.status === 'PAID';
  useEffect(() => {
    if (paid) unlocked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid]);

  // A second click must not become a second purchase: React repaints the
  // disabled state a frame late.
  const buying = useRef(false);
  const payWithWallet = useMutation({
    mutationFn: async () =>
      (await api.post('/payments/from-wallet', { courseId, couponCode })).data,
    onSuccess: () => {
      unlocked();
      onClose();
    },
    onError: (err) => {
      // Already owning the course is what a double-click looks like from the
      // second request's side — the student is in.
      if (faultOf(err)?.code === 'ALREADY_ENROLLED') {
        unlocked();
        onClose();
      }
    },
    onSettled: () => {
      buying.current = false;
      qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });
  const fault = faultOf(payWithWallet.error);

  const settle = (data: CourseCheckout) => {
    since.current = Date.now();
    qc.setQueryData(checkoutKey, data);
    qc.invalidateQueries({ queryKey: ['course', courseId] });
  };
  const declare = useMutation({
    mutationFn: async (input: DeclareInput) =>
      (await api.post('/payments/declare', { courseId, couponCode, useWallet, ...input }))
        .data as CourseCheckout,
    onSuccess: settle,
  });
  const proof = useMutation({
    mutationFn: async (input: ProofInput) =>
      (await api.post(`/payments/${view?.id}/proof`, input)).data as CourseCheckout,
    onSuccess: settle,
  });

  const payCash = useMutation({
    mutationFn: async () =>
      (
        await api.post('/payments', {
          courseId,
          method: 'CASH',
          couponCode,
          cashReceiver,
          note: cashNote.trim() || undefined,
        })
      ).data,
    onSuccess: () => {
      setCashDone(true);
      unlocked();
    },
  });

  let body: JSX.Element;
  if (checkout.isLoading) {
    body = (
      <div
        className="flex flex-col items-center gap-2 py-10 text-sm text-on-surface-variant"
        aria-live="polite"
      >
        <Spinner />
        {t('checkout.preparing')}
      </div>
    );
  } else if (paid) {
    body = (
      <div
        className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center"
        role="status"
      >
        <span className="material-symbols-outlined mb-2 text-5xl text-secondary">verified</span>
        <p className="font-heading text-lg font-bold">{t('checkout.courseConfirmedTitle')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('checkout.courseConfirmedBody')}</p>
        <button className="btn-primary mt-5" onClick={onClose}>
          <span className="material-symbols-outlined text-base">play_circle</span>
          {t('checkout.startCourse')}
        </button>
      </div>
    );
  } else if (cashDone) {
    body = (
      <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
        <span className="material-symbols-outlined mb-2 text-5xl text-secondary">
          hourglass_top
        </span>
        <p className="font-heading text-lg font-bold">{t('pay.submittedTitle')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('pay.cash.pendingHint')}</p>
        <button className="btn-primary mt-5" onClick={onClose}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (view && view.status === 'PENDING' && view.claimedAt) {
    // A receipt was sent: nothing left for the student to do.
    body = (
      <div
        className="rounded-2xl border border-outline-variant/60 p-6 text-center"
        aria-live="polite"
      >
        <span className="material-symbols-outlined mb-2 text-5xl text-primary">
          {view.stage === 'UNDER_REVIEW' ? 'fact_check' : 'hourglass_top'}
        </span>
        <p className="font-heading text-lg font-bold">
          {view.stage === 'UNDER_REVIEW' ? t('livePay.reviewTitle') : t('checkout.checkingTitle')}
        </p>
        <p className="mt-1 text-sm text-on-surface-variant">
          {view.stage === 'UNDER_REVIEW'
            ? t('checkout.reviewBodyCourse')
            : t('checkout.checkingBodyCourse')}
        </p>
        <button className="btn-ghost mt-5" onClick={onClose}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (view && view.status === 'PENDING') {
    body = (
      <div>
        <PaymentStageNote stage={view.stage} target="course" />
        {view.walletCents > 0 && (
          <p className="mb-4 text-sm text-on-surface-variant">
            {t('checkout.walletPart', { amount: egp(view.walletCents) })}
          </p>
        )}
        <LiveTransferForm
          purchase={{ studentPaysCents: view.dueCents, payment: view }}
          underReview={view.stage === 'UNDER_REVIEW'}
          onDeclare={(input) => declare.mutate(input)}
          declaring={declare.isPending}
          declareError={declare.error}
          onSubmitProof={(input) => proof.mutate(input)}
          pending={proof.isPending}
          error={proof.error}
          autoConfirmNote={t('checkout.autoConfirmCourse')}
        />
      </div>
    );
  } else {
    body = (
      <>
        {/* A balance goes toward this purchase only if the student ticks this. */}
        {balance > 0 && !cash && (
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
                  <span className="material-symbols-outlined text-[20px]">
                    account_balance_wallet
                  </span>
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
                  {payWithWallet.isPending
                    ? t('common.saving')
                    : t('pay.payNow', { amount: egp(total) })}
                </button>
                {fault?.code === 'INSUFFICIENT_BALANCE' ? (
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

        {cashDue > 0 && (
          <>
            {/* One price; a coupon discount and the wallet share are shown. */}
            <div className="mb-5 rounded-xl bg-primary-fixed/40 p-3">
              {((quote && quote.discountCents > 0) || walletApplied > 0) && (
                <div className="mb-2 space-y-1 border-b border-outline-variant pb-2 text-sm">
                  {quote && quote.discountCents > 0 && (
                    <>
                      <div className="flex justify-between text-on-surface-variant">
                        <span>{t('pay.originalPrice')}</span>
                        <span className="tabular-nums line-through">
                          {egp(quote.basePriceCents)}
                        </span>
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
                  {egp(cash ? total : cashDue)}
                </span>
              </div>
            </div>

            {cash ? (
              // Cash: a claim, not a receipt — nothing to transfer or match. It
              // waits for whoever received it to confirm.
              <div className="space-y-3">
                <div className="rounded-xl border border-outline-variant/60 p-3">
                  {(quote?.cashReceivers ?? ['TEACHER']).length > 1 && (
                    <Field label={t('pay.cash.receiver')}>
                      <select
                        className="input"
                        value={cashReceiver}
                        onChange={(e) => setCashReceiver(e.target.value as 'TEACHER' | 'CENTER')}
                      >
                        <option value="TEACHER">{t('pay.cash.receiverTeacher')}</option>
                        <option value="CENTER">{t('pay.cash.receiverCenter')}</option>
                      </select>
                    </Field>
                  )}
                  <Field label={t('pay.cash.note')}>
                    <textarea
                      className="input"
                      rows={2}
                      value={cashNote}
                      onChange={(e) => setCashNote(e.target.value)}
                      maxLength={300}
                    />
                  </Field>
                  <p className="mt-1 flex items-start gap-2 text-xs leading-5 text-on-surface-variant">
                    <span className="material-symbols-outlined text-[16px] leading-5 text-primary">
                      hourglass_top
                    </span>
                    {t('pay.cash.pendingHint')}
                  </p>
                </div>
                <ErrorNote error={payCash.error} />
                <button
                  className="btn-primary w-full"
                  disabled={payCash.isPending}
                  onClick={() => payCash.mutate()}
                >
                  {payCash.isPending ? t('common.saving') : t('pay.cash.submit')}
                </button>
              </div>
            ) : (
              <LiveTransferForm
                purchase={{ studentPaysCents: cashDue, payment: null }}
                onDeclare={(input) => declare.mutate(input)}
                declaring={declare.isPending}
                declareError={declare.error}
                onSubmitProof={(input) => proof.mutate(input)}
                pending={proof.isPending}
                error={proof.error}
                autoConfirmNote={t('checkout.autoConfirmCourse')}
              />
            )}

            <button
              type="button"
              className="mt-4 w-full text-center text-xs font-bold text-primary hover:underline"
              onClick={() => setCash((c) => !c)}
            >
              {cash ? t('checkout.payByTransfer') : t('checkout.payCash')}
            </button>
          </>
        )}
      </>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t('pay.title')} wide>
      {body}
    </Modal>
  );
}
