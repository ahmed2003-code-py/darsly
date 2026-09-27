import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { ErrorNote, Modal, Spinner } from '../ui';
import LiveTransferForm, { type DeclareInput, type ProofInput } from './LiveTransferForm';
import { RefundAndReplaySummary } from './LiveOfferFacts';

/** The structured part of a refusal, when the server sent one. */
const faultOf = (e: unknown) =>
  (
    e as {
      response?: {
        data?: { code?: string; reason?: string; balanceCents?: number; requiredCents?: number };
      };
    }
  )?.response?.data ?? null;

/** mm:ss until a hold lapses, on the server's timestamp. */
function useCountdown(until: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return { left, text: `${m}:${String(s).padStart(2, '0')}` };
}

/**
 * Buying a seat on a PAID live session.
 *
 * Every number shown is the server's: the offer, the frozen price of a hold,
 * the wallet balance. The page never says "booked" until the server has
 * confirmed the payment — a submitted transfer is "waiting for confirmation",
 * and that is all it is.
 */
export default function LiveCheckoutModal({
  sessionId,
  title,
  open,
  onClose,
}: {
  sessionId: string;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [coupon, setCoupon] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');
  const [route, setRoute] = useState<'choose' | 'transfer'>('choose');
  const busy = useRef(false);

  const offer = useQuery({
    queryKey: ['live-offer', sessionId],
    queryFn: async () => (await api.get(`/live/${sessionId}/offer`)).data,
    enabled: open,
    retry: false,
  });
  // A code is checked on its own: a bad one says why, and the price stays.
  const preview = useQuery({
    queryKey: ['live-offer', sessionId, 'coupon', appliedCoupon],
    queryFn: async () =>
      (await api.get(`/live/${sessionId}/offer`, { params: { coupon: appliedCoupon } })).data,
    enabled: open && !!appliedCoupon,
    retry: false,
  });
  const wallet = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => (await api.get('/wallet')).data,
    enabled: open,
  });
  const purchase = offer.data?.purchase;
  const active =
    purchase && ['HELD', 'PAYMENT_PENDING', 'CONFIRMED'].includes(purchase.status)
      ? purchase
      : null;
  const priced = appliedCoupon && preview.data ? preview.data : offer.data;
  const price: number | undefined = active ? active.studentPaysCents : priced?.studentPaysCents;
  const balance: number = wallet.data?.balanceCents ?? 0;
  const countdown = useCountdown(active?.status === 'HELD' ? active.holdExpiresAt : null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['live-offer', sessionId] });
    qc.invalidateQueries({ queryKey: ['live-upcoming'] });
    qc.invalidateQueries({ queryKey: ['wallet'] });
  };
  const settle = () => {
    busy.current = false;
    refresh();
  };

  const hold = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/live/${sessionId}/purchase`, {
          couponCode: (preview.data && appliedCoupon) || undefined,
        })
      ).data,
    onSuccess: () => setRoute('transfer'),
    onSettled: settle,
  });
  const payWallet = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/live/${sessionId}/purchase/wallet`, {
          couponCode: (preview.data && appliedCoupon) || undefined,
        })
      ).data,
    onSettled: settle,
  });
  // Before the transfer: where the money comes from (writes the pending payment).
  const declare = useMutation({
    mutationFn: async (input: DeclareInput) =>
      (await api.post(`/live/purchases/${(active ?? hold.data).id}/declare`, input)).data,
    onSettled: settle,
  });
  const transfer = useMutation({
    mutationFn: async (input: ProofInput) =>
      (await api.post(`/live/purchases/${(active ?? hold.data).id}/transfer`, input)).data,
    onSettled: settle,
  });

  // While a payment is being verified, look again every few seconds: the
  // listener usually confirms within moments of the bank's SMS.
  useEffect(() => {
    if (active?.status !== 'PAYMENT_PENDING') return;
    const i = setInterval(
      () => qc.invalidateQueries({ queryKey: ['live-offer', sessionId] }),
      5000,
    );
    return () => clearInterval(i);
  }, [active?.status, qc, sessionId]);

  const couponFault = faultOf(preview.error);
  const once = (fn: () => void) => () => {
    if (busy.current) return;
    busy.current = true;
    fn();
  };

  let body: React.ReactNode;
  if (offer.isLoading) {
    body = (
      <div className="grid place-items-center py-10">
        <Spinner />
      </div>
    );
  } else if (active?.status === 'CONFIRMED') {
    body = (
      <div className="rounded-2xl border border-secondary/40 bg-secondary-container/30 p-6 text-center">
        <span className="material-symbols-outlined mb-2 text-5xl text-secondary">
          event_available
        </span>
        <p className="font-heading text-lg font-bold">{t('liveBuy.confirmedTitle')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('liveBuy.confirmedBody')}</p>
        <button className="btn-primary mt-5" onClick={onClose}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (active?.status === 'PAYMENT_PENDING') {
    body = (
      <div
        className="rounded-2xl border border-outline-variant/60 bg-surface-container-low/60 p-6 text-center"
        aria-live="polite"
      >
        <span className="material-symbols-outlined mb-2 text-5xl text-primary">hourglass_top</span>
        <p className="font-heading text-lg font-bold">{t('liveBuy.pendingTitle')}</p>
        <p className="mt-1 text-sm text-on-surface-variant">{t('liveBuy.pendingBody')}</p>
        <button className="btn-ghost mt-5" onClick={onClose}>
          {t('common.back')}
        </button>
      </div>
    );
  } else if (active?.status === 'HELD' || route === 'transfer') {
    const p = active ?? hold.data;
    body = p ? (
      <div>
        {countdown && (
          <p
            className={`mb-4 flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
              countdown.left < 5 * 60_000
                ? 'bg-error-container text-on-error-container'
                : 'bg-surface-container-low text-on-surface-variant'
            }`}
            aria-live="polite"
          >
            <span className="material-symbols-outlined text-[18px]">timer</span>
            {t('liveBuy.heldFor', { time: countdown.text })}
          </p>
        )}
        <LiveTransferForm
          purchase={p}
          onDeclare={(input) => declare.mutate(input)}
          declaring={declare.isPending}
          declareError={declare.error}
          onSubmitProof={(input) => transfer.mutate(input)}
          pending={transfer.isPending}
          error={transfer.error}
        />
        {/* Once a transfer is declared, paying again from the wallet could take the money twice. */}
        {!p.payment && balance >= p.studentPaysCents && (
          <button
            className="btn-ghost mt-4 w-full"
            disabled={payWallet.isPending}
            onClick={once(() => payWallet.mutate())}
          >
            <span className="material-symbols-outlined text-base">account_balance_wallet</span>
            {t('liveBuy.payFromWalletInstead', { amount: egp(p.studentPaysCents) })}
          </button>
        )}
        <ErrorNote error={payWallet.error} />
      </div>
    ) : null;
  } else {
    const enough = price != null && balance >= price;
    body = (
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-2xl bg-primary-fixed/40 p-4">
          <span className="text-sm text-on-surface-variant">{t('liveBuy.seatPrice')}</span>
          <span className="text-end">
            {priced?.fullPriceCents != null && priced.fullPriceCents !== price && (
              <span className="me-2 text-sm text-outline line-through tabular-nums">
                {egp(priced.fullPriceCents)}
              </span>
            )}
            <span className="font-heading text-2xl font-bold text-primary tabular-nums">
              {egp(price)}
            </span>
          </span>
        </div>
        {offer.data && <RefundAndReplaySummary offer={offer.data} />}
        <div className="flex gap-2">
          <input
            className="input flex-1"
            dir="ltr"
            value={coupon}
            maxLength={24}
            placeholder={t('liveBuy.couponPh')}
            aria-label={t('liveBuy.coupon')}
            aria-invalid={couponFault?.code === 'COUPON_INVALID' || undefined}
            onChange={(e) => setCoupon(e.target.value.toUpperCase())}
          />
          <button
            className="btn-ghost"
            disabled={!coupon.trim()}
            onClick={() => setAppliedCoupon(coupon.trim())}
          >
            {t('liveBuy.applyCoupon')}
          </button>
        </div>
        {couponFault?.code === 'COUPON_INVALID' && (
          <p className="text-sm text-error" role="alert">
            {t(`liveBuy.couponReason.${couponFault.reason ?? 'not-found'}`)}
          </p>
        )}
        {offer.data?.seatsLeft === 0 && (
          <p className="text-sm font-semibold text-error">{t('live.full')}</p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            className="btn-primary"
            disabled={!enough || payWallet.isPending || offer.data?.seatsLeft === 0}
            aria-busy={payWallet.isPending || undefined}
            onClick={once(() => payWallet.mutate())}
          >
            <span className="material-symbols-outlined text-base">account_balance_wallet</span>
            {payWallet.isPending ? t('common.saving') : t('liveBuy.payFromWallet')}
          </button>
          <button
            className="btn-ghost"
            disabled={hold.isPending || offer.data?.seatsLeft === 0}
            aria-busy={hold.isPending || undefined}
            onClick={once(() => hold.mutate())}
          >
            <span className="material-symbols-outlined text-base">north_east</span>
            {hold.isPending ? t('common.saving') : t('liveBuy.payByTransfer')}
          </button>
        </div>
        <p className="text-xs text-on-surface-variant">
          {t('liveBuy.walletBalance', { amount: egp(balance) })}
          {!enough && price != null && ` · ${t('liveBuy.walletShort')}`}
        </p>
        {faultOf(payWallet.error)?.code === 'INSUFFICIENT_BALANCE' ? (
          <p className="rounded-xl border border-error/15 bg-error-container px-4 py-2 text-sm text-on-error-container">
            {t('pay.shortBalance', {
              balance: egp(faultOf(payWallet.error)?.balanceCents ?? 0),
              required: egp(faultOf(payWallet.error)?.requiredCents ?? price ?? 0),
            })}
          </p>
        ) : (
          <ErrorNote error={payWallet.error || hold.error} />
        )}
      </div>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t('liveBuy.title', { title })} wide>
      {body}
    </Modal>
  );
}
