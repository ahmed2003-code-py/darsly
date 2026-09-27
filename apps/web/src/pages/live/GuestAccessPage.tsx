import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { backoffInterval, countdown } from '../../lib/livePolling';
import LivePublicShell, { skewFrom, useNow } from '../../components/live/LivePublicShell';
import { Role } from '@darsly/shared-types';
import { api, apiOrigin } from '../../lib/api';
import { egp } from '../../lib/format';
import { enterAsGuest, rememberGuestSecret } from '../../lib/guest';
import { confirmDelete } from '../../lib/confirm';
import { useAuthStore } from '../../stores/auth';
import { ErrorNote, Field, Spinner } from '../../components/ui';
import PaymentStageNote from '../../components/payments/PaymentStageNote';
import LiveTransferForm, { type DeclareInput, type ProofInput } from '../../components/live/LiveTransferForm';

const REFUND_METHODS = ['VODAFONE_CASH', 'INSTAPAY', 'BANK_TRANSFER'] as const;

/** Where a refund should go: the account a guest names when money is owed. */
function RefundDestinationForm({
  onSubmit,
  pending,
  error,
  submitLabel,
}: {
  onSubmit: (d: { method: string; holderName: string; handle: string }) => void;
  pending: boolean;
  error: unknown;
  submitLabel: string;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<string>('VODAFONE_CASH');
  const [holderName, setHolderName] = useState('');
  const [handle, setHandle] = useState('');
  const ok = holderName.trim().length >= 2 && handle.trim().length >= 4;
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !pending)
          onSubmit({ method, holderName: holderName.trim(), handle: handle.trim() });
      }}
    >
      <Field label={t('guest.refundMethod')} id="refund-method">
        <select
          id="refund-method"
          className="input"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          {REFUND_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('guest.refundHolder')} id="refund-holder">
        <input
          id="refund-holder"
          className="input"
          dir="auto"
          maxLength={80}
          value={holderName}
          onChange={(e) => setHolderName(e.target.value)}
        />
      </Field>
      <Field
        label={t(method === 'VODAFONE_CASH' ? 'guest.refundWallet' : 'guest.refundAccount')}
        id="refund-handle"
      >
        <input
          id="refund-handle"
          className="input"
          dir="ltr"
          maxLength={64}
          inputMode={method === 'VODAFONE_CASH' ? 'tel' : 'text'}
          placeholder={method === 'VODAFONE_CASH' ? '01xxxxxxxxx' : ''}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <button className="btn-primary w-full" disabled={!ok || pending}>
        {pending ? t('common.saving') : submitLabel}
      </button>
    </form>
  );
}

/**
 * A guest's own page for the seat they bought, opened by its private link.
 *
 * Every state comes from the server and is re-read while it can change: a
 * hold waiting for a transfer, a payment being verified (usually confirmed by
 * the bank's SMS within moments), a confirmed seat with a way into the
 * classroom once it opens, and — if it comes to it — the refund and where to
 * send it.
 */
export default function GuestAccessPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const once = useRef(false);
  const signedIn = useAuthStore((s) => s.user);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  // When the current state began: polling is quick right after a change
  // (a transfer just sent) and backs off the longer nothing happens.
  const since = useRef(Date.now());
  const lastState = useRef<string | null>(null);

  useEffect(() => {
    rememberGuestSecret(token);
  }, [token]);

  const status = useQuery({
    queryKey: ['guest-access', token],
    queryFn: async () => {
      const data = (await api.get(`/public/live/access/${encodeURIComponent(token)}`)).data;
      setReceivedAt(Date.now());
      const key = `${data.status}:${data.paymentStage}:${data.canEnter}`;
      if (key !== lastState.current) {
        lastState.current = key;
        since.current = Date.now();
      }
      return data;
    },
    retry: false,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      // Waiting on money, or on the teacher to open the room: keep looking.
      const moving =
        d.status === 'HELD' ||
        d.status === 'PAYMENT_PENDING' ||
        (d.status === 'CONFIRMED' && !d.canEnter && !d.session.over && !d.session.cancelled);
      return moving ? backoffInterval(since.current) : false;
    },
    refetchOnWindowFocus: true,
  });
  const s = status.data;
  const refresh = () => {
    since.current = Date.now();
    qc.invalidateQueries({ queryKey: ['guest-access', token] });
  };

  const declare = useMutation({
    mutationFn: async (input: DeclareInput) =>
      (await api.post(`/public/live/access/${encodeURIComponent(token)}/declare`, input)).data,
    onSettled: refresh,
  });
  const transfer = useMutation({
    mutationFn: async (input: ProofInput) =>
      (await api.post(`/public/live/access/${encodeURIComponent(token)}/transfer`, input)).data,
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: async (d: { method?: string; holderName?: string; handle?: string }) =>
      (await api.post(`/public/live/access/${encodeURIComponent(token)}/cancel`, d)).data,
    onSuccess: () => setCancelling(false),
    onSettled: refresh,
  });
  const destination = useMutation({
    mutationFn: async ({
      refundId,
      ...d
    }: {
      refundId: string;
      method: string;
      holderName: string;
      handle: string;
    }) =>
      (
        await api.post(
          `/public/live/access/${encodeURIComponent(token)}/refunds/${refundId}/destination`,
          d,
        )
      ).data,
    onSettled: refresh,
  });
  const enter = useMutation({
    mutationFn: async () => enterAsGuest(`${apiOrigin()}/api/v1`, token),
    onSuccess: (sessionId) => navigate(`/live/${sessionId}/meeting`),
    onSettled: () => {
      once.current = false;
    },
  });

  const skew = skewFrom(s?.serverNow, receivedAt);
  const now = useNow(!!s, skew);
  const link = `${window.location.origin}/live/access/${token}`;
  const start = s ? new Date(s.session.startsAt).getTime() : 0;
  const beforeStart = !!s && now < start;
  const opensIn = s ? countdown(new Date(s.session.joinOpensAt).getTime(), now) : null;
  const holdLeft = s?.holdExpiresAt ? countdown(new Date(s.holdExpiresAt).getTime(), now) : null;
  const seated = s?.status === 'CONFIRMED';
  const canManage = !!s && !s.session.cancelled && (s.status === 'HELD' || (seated && beforeStart));

  async function goIn() {
    if (once.current) return;
    // Entering as a guest replaces whoever is signed in on this device.
    if (signedIn && signedIn.role !== Role.GUEST) {
      const ok = await confirmDelete({
        kind: 'cancel',
        message: t('guest.replacesSession', { name: signedIn.fullName }),
      });
      if (!ok) return;
    }
    once.current = true;
    enter.mutate();
  }

  const chip = !s ? null : s.session.cancelled ? (
    <span className="rounded-full bg-error-container px-3 py-1 text-xs font-bold text-on-error-container">{t('livePublic.cancelled')}</span>
  ) : s.session.over ? (
    <span className="rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-on-surface-variant">{t('livePublic.ended')}</span>
  ) : s.session.live ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-error-container px-3 py-1 text-xs font-bold text-on-error-container">
      <span className="h-2 w-2 animate-pulse rounded-full bg-error motion-reduce:animate-none" />
      {t('live.liveNow')}
    </span>
  ) : beforeStart ? (
    <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container tabular-nums">
      {t('livePublic.startsIn', { time: countdown(start, now) })}
    </span>
  ) : (
    <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">{t('livePublic.waitingTeacher')}</span>
  );

  return (
    <LivePublicShell>
      {status.isLoading ? (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      ) : !s ? (
        <div className="card text-center">
          <span className="material-symbols-outlined text-5xl text-outline">link_off</span>
          <p className="mt-2 font-heading text-lg font-bold">{t('guest.linkInvalid')}</p>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-on-surface-variant">{t('guest.hello', { name: s.guestName })}</p>
              {chip}
            </div>
            <h1 className="mt-1 font-heading text-xl font-bold" dir="auto">
              {s.session.title}
            </h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              {new Date(s.session.startsAt).toLocaleString('ar-EG', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {' · '}
              {t('live.minutes', { count: s.session.durationMin })}
              {s.free && (
                <span className="ms-2 rounded-full bg-secondary-container px-2 py-0.5 text-xs font-bold text-on-secondary-container">
                  {t('liveBuy.free')}
                </span>
              )}
            </p>
            {params.get('new') && (
              <div className="mt-4 rounded-xl border border-secondary/40 bg-secondary-container/30 p-3 text-sm">
                <p className="font-bold">{t('guest.keepLink')}</p>
                <div className="mt-2 flex gap-2">
                  <input className="input flex-1 text-xs" dir="ltr" readOnly value={link} aria-label={t('guest.yourLink')} />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                    }}
                  >
                    {copied ? t('guest.copied') : t('guest.copy')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {s.session.cancelled && s.status !== 'HELD' && (
            <div className="card border-error/30 bg-error-container/40 text-sm">{t('guest.sessionCancelled')}</div>
          )}

          {/* Paying: the transfer, then the stage it is at — never "pay again". */}
          {(s.status === 'HELD' || s.status === 'EXPIRED') && !s.session.cancelled && !s.free && (
            <div className="card">
              <p className="mb-1 font-heading font-bold">{t('guest.payNow')}</p>
              {s.status === 'HELD' && holdLeft && (
                <p className="mb-3 text-xs text-on-surface-variant tabular-nums">{t('liveBuy.heldFor', { time: holdLeft })}</p>
              )}
              {s.status === 'EXPIRED' && <p className="mb-3 text-sm text-on-surface-variant">{t('guest.holdExpired')}</p>}
              <PaymentStageNote stage={s.paymentStage} target="live" />
              <LiveTransferForm
                purchase={s}
                underReview={s.paymentStage === 'UNDER_REVIEW'}
                onDeclare={(input) => declare.mutate(input)}
                declaring={declare.isPending}
                declareError={declare.error}
                onSubmitProof={(input) => transfer.mutate(input)}
                pending={transfer.isPending}
                error={transfer.error}
              />
            </div>
          )}

          {s.status === 'PAYMENT_PENDING' && (
            <div className="card text-center" aria-live="polite">
              <span className="material-symbols-outlined text-5xl text-primary">
                {s.paymentStage === 'UNDER_REVIEW' ? 'fact_check' : 'hourglass_top'}
              </span>
              <p className="font-heading text-lg font-bold">
                {s.paymentStage === 'UNDER_REVIEW' ? t('livePay.reviewTitle') : t('liveBuy.pendingTitle')}
              </p>
              <p className="mt-1 text-sm text-on-surface-variant">
                {s.paymentStage === 'UNDER_REVIEW' ? t('livePay.reviewBody') : t('livePay.checkingBody')}
              </p>
            </div>
          )}

          {/* A seat: the one thing to do next, by the clock. */}
          {seated && !s.session.cancelled && (
            <div className="card space-y-3" aria-live="polite">
              <p className="flex items-center gap-2 font-heading text-lg font-bold">
                <span className="material-symbols-outlined text-secondary">event_available</span>
                {s.free ? t('livePublic.seatConfirmed') : t('liveBuy.confirmedTitle')}
              </p>
              {s.session.over ? (
                <p className="text-sm text-on-surface-variant">{t('guest.classOver')}</p>
              ) : s.canEnter ? (
                <>
                  <p className="text-sm text-on-surface-variant">{t('guest.canEnter')}</p>
                  <button className="btn-primary w-full py-3 text-base" disabled={enter.isPending} onClick={goIn}>
                    <span className="material-symbols-outlined">videocam</span>
                    {enter.isPending ? t('common.saving') : t('live.join')}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm text-on-surface-variant tabular-nums">
                    {opensIn ? t('livePublic.opensIn', { time: opensIn }) : t('livePublic.waitingTeacherHint')}
                  </p>
                  <button className="btn-ghost w-full" disabled={enter.isPending} onClick={goIn}>
                    <span className="material-symbols-outlined text-base">settings_voice</span>
                    {t('livePublic.prepareDevices')}
                  </button>
                </>
              )}
              <ErrorNote error={enter.error} />
            </div>
          )}

          {['DELIVERED', 'NEEDS_REVIEW'].includes(s.status) && (
            <div className="card text-center text-sm text-on-surface-variant">{t('guest.classOver')}</div>
          )}

          {['PAYMENT_REJECTED', 'OVERSOLD', 'REFUNDED', 'REFUND_PENDING', 'CANCELLED_BY_TEACHER', 'CANCELLED_BY_STUDENT'].includes(s.status) && (
            <div className="card text-sm">
              <p className="font-bold">{t(`liveBuy.statusNote.${s.status}`)}</p>
              {s.payment?.rejectedReason && <p className="mt-1 text-on-surface-variant">{s.payment.rejectedReason}</p>}
            </div>
          )}

          {/* Refunds owed: what, how far along, and where to send it. */}
          {s.refunds.map((r: any) => (
            <div key={r.id} className="card space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-heading font-bold">{t('guest.refundTitle')}</p>
                <span className="font-heading text-xl font-bold text-primary-text tabular-nums">{egp(r.amountCents)}</span>
              </div>
              <p className="text-sm text-on-surface-variant">{t(`guest.refundStatus.${r.status}`)}</p>
              {r.needsDestination && (
                <RefundDestinationForm
                  submitLabel={t('guest.sendRefundHere')}
                  pending={destination.isPending}
                  error={destination.error}
                  onSubmit={(d) => destination.mutate({ refundId: r.id, ...d })}
                />
              )}
            </div>
          ))}

          {/* Managing the booking is a separate, quieter place — never beside "enter". */}
          {canManage && (
            <details className="card group" onToggle={(e) => !(e.target as HTMLDetailsElement).open && setCancelling(false)}>
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-on-surface-variant">
                {t('livePublic.manage')}
                <span className="material-symbols-outlined text-base transition group-open:rotate-180">expand_more</span>
              </summary>
              <div className="mt-3">
                {!cancelling ? (
                  <button className="btn-ghost w-full text-error" onClick={() => setCancelling(true)}>
                    {t('guest.cancelSeat')}
                  </button>
                ) : s.status === 'HELD' || s.free ? (
                  <div className="space-y-3">
                    <p className="text-sm">{s.free ? t('livePublic.cancelFree') : t('guest.cancelHeld')}</p>
                    <button className="btn-primary w-full" disabled={cancel.isPending} onClick={() => cancel.mutate({})}>
                      {t('guest.confirmCancel')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm">{t('guest.cancelConfirmed')}</p>
                    <RefundDestinationForm
                      submitLabel={t('guest.confirmCancel')}
                      pending={cancel.isPending}
                      error={cancel.error}
                      onSubmit={(d) => cancel.mutate(d)}
                    />
                  </div>
                )}
                <ErrorNote error={cancel.error} />
              </div>
            </details>
          )}
        </>
      )}
    </LivePublicShell>
  );
}

/** What the buyer's money is doing — said plainly, and never "pay again". */
