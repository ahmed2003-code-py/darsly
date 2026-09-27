import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { rememberGuestSecret } from '../../lib/guest';
import { ErrorNote, Field, Spinner } from '../../components/ui';
import { RefundAndReplaySummary } from '../../components/live/LiveOfferFacts';

function when(iso: string) {
  return new Date(iso).toLocaleString('ar-EG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A paid live class anyone can buy a seat on — no account needed.
 *
 * Only a name is asked. What comes back is a private link (the access
 * secret) that is the guest's whole relationship with Darsly for this class:
 * pay through it, wait for confirmation on it, and enter the classroom from
 * it. The link is shown once; the page says so.
 */
export default function PublicLivePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [coupon, setCoupon] = useState('');
  const once = useRef(false);

  const offer = useQuery({
    queryKey: ['public-live', id],
    queryFn: async () => (await api.get(`/public/live/${id}`)).data,
    retry: false,
  });

  const buy = useMutation({
    mutationFn: async () =>
      (
        await api.post(`/public/live/${id}/guest-purchase`, {
          displayName: name.trim(),
          couponCode: coupon.trim() || undefined,
        })
      ).data as { accessToken: string },
    onSuccess: ({ accessToken }) => {
      rememberGuestSecret(accessToken);
      navigate(`/live/access/${accessToken}?new=1`, { replace: true });
    },
    onSettled: () => {
      once.current = false;
    },
  });

  const o = offer.data;
  const nameOk = name.trim().length >= 2 && name.trim().length <= 60;
  const closed = !!o?.closed || o?.seatsLeft === 0;

  return (
    <div className="min-h-screen bg-surface px-4 py-10" dir="rtl">
      <div className="mx-auto w-full max-w-xl">
        <p className="mb-6 text-center font-heading text-2xl font-extrabold text-primary">درسلي</p>
        {offer.isLoading ? (
          <div className="grid place-items-center py-20">
            <Spinner />
          </div>
        ) : !o ? (
          <div className="card text-center">
            <span className="material-symbols-outlined text-5xl text-outline">event_busy</span>
            <p className="mt-2 font-heading text-lg font-bold">{t('guest.notFound')}</p>
          </div>
        ) : (
          <div className="card space-y-5">
            <div>
              <p className="text-sm text-primary">{o.teacherName}</p>
              <h1 className="font-heading text-2xl font-bold">{o.title}</h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-on-surface-variant">
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-base">event</span>
                  {when(o.startsAt)}
                </span>
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-base">schedule</span>
                  {t('live.minutes', { count: o.durationMin })}
                </span>
                {o.capacity != null && (
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-base">group</span>
                    {t('live.seatsLeft', { count: o.seatsLeft })}
                  </span>
                )}
              </p>
              {o.description && (
                <p className="mt-3 whitespace-pre-line text-sm text-on-surface-variant">
                  {o.description}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-primary-fixed/40 p-4">
              <span className="text-sm text-on-surface-variant">{t('liveBuy.seatPrice')}</span>
              <span className="font-heading text-3xl font-bold text-primary tabular-nums">
                {egp(o.studentPaysCents)}
              </span>
            </div>
            <RefundAndReplaySummary offer={o} />

            {closed ? (
              <p className="rounded-xl bg-error-container px-4 py-3 text-sm font-semibold text-on-error-container">
                {o.closed ? t('guest.closed') : t('live.full')}
              </p>
            ) : (
              <form
                noValidate
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!nameOk || once.current || buy.isPending) return;
                  once.current = true;
                  buy.mutate();
                }}
              >
                <Field label={t('guest.yourName')} id="guest-name" hint={t('guest.yourNameHint')}>
                  <input
                    id="guest-name"
                    className="input"
                    dir="auto"
                    autoComplete="name"
                    maxLength={60}
                    value={name}
                    aria-invalid={!!name && !nameOk}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label={t('liveBuy.coupon')} id="guest-coupon">
                  <input
                    id="guest-coupon"
                    className="input"
                    dir="ltr"
                    maxLength={24}
                    value={coupon}
                    placeholder={t('liveBuy.couponPh')}
                    onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                  />
                </Field>
                <ErrorNote error={buy.error} />
                <button
                  className="btn-primary w-full"
                  disabled={!nameOk || buy.isPending}
                  aria-busy={buy.isPending || undefined}
                >
                  <span className="material-symbols-outlined text-base">shopping_cart</span>
                  {buy.isPending ? t('common.saving') : t('guest.reserve')}
                </button>
                <p className="text-center text-xs text-outline">{t('guest.noAccountNeeded')}</p>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
