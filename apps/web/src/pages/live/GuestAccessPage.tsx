import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api, apiOrigin } from '../../lib/api';
import { egp } from '../../lib/format';
import { enterAsGuest, rememberGuestSecret } from '../../lib/guest';
import { confirmDelete } from '../../lib/confirm';
import { useAuthStore } from '../../stores/auth';
import { ErrorNote, Field, Spinner } from '../../components/ui';
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

  useEffect(() => {
    rememberGuestSecret(token);
  }, [token]);

  const status = useQuery({
    queryKey: ['guest-access', token],
    queryFn: async () => (await api.get(`/public/live/access/${encodeURIComponent(token)}`)).data,
    retry: false,
    refetchInterval: (q) =>
      ['HELD', 'PAYMENT_PENDING', 'CONFIRMED'].includes(q.state.data?.status) ? 10_000 : false,
  });
  const s = status.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['guest-access', token] });

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

  const link = `${window.location.origin}/live/access/${token}`;
  const start = s ? new Date(s.session.startsAt) : null;
  const beforeStart = !!start && Date.now() < start.getTime();

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

  return (
    <div className="min-h-screen bg-surface px-4 py-10" dir="rtl">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <p className="text-center font-heading text-2xl font-extrabold text-primary">درسلي</p>
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
              <p className="text-sm text-on-surface-variant">
                {t('guest.hello', { name: s.guestName })}
              </p>
              <h1 className="font-heading text-xl font-bold">{s.session.title}</h1>
              <p className="mt-1 text-sm text-on-surface-variant">
                {start?.toLocaleString('ar-EG', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {' · '}
                {t('live.minutes', { count: s.session.durationMin })}
              </p>
              {params.get('new') && (
                <div className="mt-4 rounded-xl border border-secondary/40 bg-secondary-container/30 p-3 text-sm">
                  <p className="font-bold">{t('guest.keepLink')}</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      className="input flex-1 text-xs"
                      dir="ltr"
                      readOnly
                      value={link}
                      aria-label={t('guest.yourLink')}
                    />
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
              <div className="card border-error/30 bg-error-container/40 text-sm">
                {t('guest.sessionCancelled')}
              </div>
            )}

            {(s.status === 'HELD' || s.status === 'EXPIRED') && !s.session.cancelled && (
              <div className="card">
                <p className="mb-3 font-heading font-bold">{t('guest.payNow')}</p>
                {s.status === 'EXPIRED' && (
                  <p className="mb-3 text-sm text-on-surface-variant">{t('guest.holdExpired')}</p>
                )}
                <LiveTransferForm
                  purchase={s}
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
                  hourglass_top
                </span>
                <p className="font-heading text-lg font-bold">{t('liveBuy.pendingTitle')}</p>
                <p className="mt-1 text-sm text-on-surface-variant">{t('guest.pendingBody')}</p>
              </div>
            )}

            {s.status === 'CONFIRMED' && (
              <div className="card text-center">
                <span className="material-symbols-outlined text-5xl text-secondary">
                  event_available
                </span>
                <p className="font-heading text-lg font-bold">{t('liveBuy.confirmedTitle')}</p>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {s.canEnter
                    ? t('guest.canEnter')
                    : t('guest.entersLater', {
                        time: new Date(s.session.joinOpensAt).toLocaleTimeString('ar-EG', {
                          hour: 'numeric',
                          minute: '2-digit',
                        }),
                      })}
                </p>
                <button
                  className="btn-primary mt-4 w-full sm:w-auto"
                  disabled={!s.canEnter || enter.isPending}
                  onClick={goIn}
                >
                  <span className="material-symbols-outlined text-base">videocam</span>
                  {enter.isPending ? t('common.saving') : t('live.join')}
                </button>
                <ErrorNote error={enter.error} />
              </div>
            )}

            {['DELIVERED', 'NEEDS_REVIEW'].includes(s.status) && (
              <div className="card text-center text-sm text-on-surface-variant">
                {t('guest.classOver')}
              </div>
            )}

            {s.status === 'PAYMENT_REJECTED' && (
              <div className="card text-sm">
                <p className="font-bold text-error">{t('liveBuy.statusNote.PAYMENT_REJECTED')}</p>
                {s.payment?.rejectedReason && (
                  <p className="mt-1 text-on-surface-variant">{s.payment.rejectedReason}</p>
                )}
              </div>
            )}

            {/* Refunds owed: what, how far along, and where to send it. */}
            {s.refunds.map((r: any) => (
              <div key={r.id} className="card space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-heading font-bold">{t('guest.refundTitle')}</p>
                  <span className="font-heading text-xl font-bold text-primary tabular-nums">
                    {egp(r.amountCents)}
                  </span>
                </div>
                <p className="text-sm text-on-surface-variant">
                  {t(`guest.refundStatus.${r.status}`)}
                </p>
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

            {(s.status === 'HELD' || (s.status === 'CONFIRMED' && beforeStart)) &&
              !s.session.cancelled && (
                <div className="card">
                  {!cancelling ? (
                    <button
                      className="btn-ghost w-full text-error"
                      onClick={() => setCancelling(true)}
                    >
                      {t('guest.cancelSeat')}
                    </button>
                  ) : s.status === 'HELD' ? (
                    <div className="space-y-3">
                      <p className="text-sm">{t('guest.cancelHeld')}</p>
                      <button
                        className="btn-primary w-full"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate({})}
                      >
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
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
