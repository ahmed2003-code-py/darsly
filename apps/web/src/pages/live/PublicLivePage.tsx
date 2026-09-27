import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Role } from '@darsly/shared-types';
import { api } from '../../lib/api';
import { egp } from '../../lib/format';
import { rememberGuestSecret } from '../../lib/guest';
import { countdown } from '../../lib/livePolling';
import { loginUrlFor } from '../../lib/redirect';
import { useAuthStore } from '../../stores/auth';
import { ErrorNote, Field, Spinner } from '../../components/ui';
import { RefundAndReplaySummary } from '../../components/live/LiveOfferFacts';
import LiveCheckoutModal from '../../components/live/LiveCheckoutModal';
import LivePublicShell, { skewFrom, useNow } from '../../components/live/LivePublicShell';

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
 * A live class's public page — the one link a teacher shares.
 *
 * FREE or PAID, anyone can open it. What it offers depends on who is looking:
 * a signed-in student books (free) or buys (paid) with their account and goes
 * on to the classroom from here; the teacher is sent to manage it; anyone
 * else takes a seat as a guest with just a name, and gets a private link that
 * is their whole relationship with Darsly for this class.
 */
export default function PublicLivePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const signedIn = useAuthStore((s) => !!s.accessToken) && !!user && user.role !== Role.GUEST;
  const asStudent = signedIn && user?.role === Role.STUDENT;
  const [name, setName] = useState('');
  const [coupon, setCoupon] = useState('');
  const [buying, setBuying] = useState(false);
  const once = useRef(false);
  const [receivedAt] = useState(() => Date.now());

  const offer = useQuery({
    queryKey: ['public-live', id],
    queryFn: async () => (await api.get(`/public/live/${id}`)).data,
    retry: false,
    // The door opens and closes on the server's clock: look again now and then.
    refetchInterval: 30_000,
  });
  const mine = useQuery({
    queryKey: ['live-my-access', id],
    queryFn: async () => (await api.get(`/live/${id}/my-access`)).data,
    enabled: asStudent,
    retry: false,
    refetchInterval: 20_000,
  });

  const guestSeat = useMutation({
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
  const book = useMutation({
    mutationFn: async () => (await api.post(`/live/${id}/book`)).data,
    onSettled: () => {
      once.current = false;
      qc.invalidateQueries({ queryKey: ['live-my-access', id] });
      qc.invalidateQueries({ queryKey: ['public-live', id] });
    },
  });

  const o = offer.data;
  const skew = skewFrom(o?.serverNow, receivedAt);
  const now = useNow(!!o, skew);
  const free = o?.accessMode === 'FREE';
  const nameOk = name.trim().length >= 2 && name.trim().length <= 60;
  const full = o?.seatsLeft === 0;
  const over = !!o?.closed;
  const startsIn = o ? countdown(new Date(o.startsAt).getTime(), now) : null;
  const m = mine.data;

  const status = !o ? null : over ? (
    <span className="rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-on-surface-variant">
      {t('livePublic.ended')}
    </span>
  ) : o.live ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-error-container px-3 py-1 text-xs font-bold text-on-error-container">
      <span className="h-2 w-2 animate-pulse rounded-full bg-error motion-reduce:animate-none" />
      {t('live.liveNow')}
    </span>
  ) : startsIn ? (
    <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container tabular-nums">
      {t('livePublic.startsIn', { time: startsIn })}
    </span>
  ) : (
    <span className="rounded-full bg-secondary-container px-3 py-1 text-xs font-bold text-on-secondary-container">
      {t('livePublic.waitingTeacher')}
    </span>
  );

  /** A student who holds a seat: the way in, or the way to get ready. */
  const seatActions = (
    <div className="space-y-2 rounded-2xl border border-secondary/40 bg-secondary-container/30 p-4">
      <p className="flex items-center gap-2 font-heading font-bold">
        <span className="material-symbols-outlined text-secondary">event_available</span>
        {t('livePublic.seatConfirmed')}
      </p>
      <button className="btn-primary w-full" onClick={() => navigate(`/live/${id}/meeting`)}>
        <span className="material-symbols-outlined text-base">{m?.canJoin ? 'videocam' : 'settings_voice'}</span>
        {m?.canJoin ? t('live.join') : t('livePublic.prepareDevices')}
      </button>
      {!m?.canJoin && <p className="text-xs text-on-surface-variant">{t('livePublic.prepareHint')}</p>}
    </div>
  );

  let action: React.ReactNode = null;
  if (o && !over) {
    if (asStudent) {
      if (mine.isLoading) action = <Spinner />;
      else if (m?.booked) action = seatActions;
      else if (full) action = <p className="text-sm font-semibold text-error">{t('live.full')}</p>;
      else if (free)
        action = (
          <div className="space-y-2">
            <button
              className="btn-primary w-full"
              disabled={book.isPending}
              aria-busy={book.isPending || undefined}
              onClick={() => {
                if (once.current) return;
                once.current = true;
                book.mutate();
              }}
            >
              <span className="material-symbols-outlined text-base">event_available</span>
              {book.isPending ? t('common.saving') : t('livePublic.bookFree')}
            </button>
            <ErrorNote error={book.error} />
          </div>
        );
      else
        action = (
          <button className="btn-primary w-full" onClick={() => setBuying(true)}>
            <span className="material-symbols-outlined text-base">shopping_cart</span>
            {t('liveBuy.buyCta')}
          </button>
        );
    } else if (signedIn) {
      // A teacher (or staff) looking at their own link.
      action = (
        <div className="space-y-2 text-sm">
          <p className="text-on-surface-variant">{t('livePublic.signedInNotStudent')}</p>
          {user?.role === Role.TEACHER && (
            <Link to={`/teacher/live/${id}`} className="btn-ghost w-full">
              <span className="material-symbols-outlined text-base">tune</span>
              {t('liveManage.open')}
            </Link>
          )}
        </div>
      );
    } else if (full) {
      action = <p className="rounded-xl bg-error-container px-4 py-3 text-sm font-semibold text-on-error-container">{t('live.full')}</p>;
    } else {
      action = (
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameOk || once.current || guestSeat.isPending) return;
            once.current = true;
            guestSeat.mutate();
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
          {!free && (
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
          )}
          <ErrorNote error={guestSeat.error} />
          <button className="btn-primary w-full" disabled={!nameOk || guestSeat.isPending} aria-busy={guestSeat.isPending || undefined}>
            <span className="material-symbols-outlined text-base">{free ? 'event_available' : 'shopping_cart'}</span>
            {guestSeat.isPending ? t('common.saving') : free ? t('livePublic.reserveFree') : t('guest.reserve')}
          </button>
          <p className="text-center text-xs text-outline">
            {t('guest.noAccountNeeded')}{' '}
            <Link to={loginUrlFor(location.pathname)} className="font-semibold text-primary hover:underline">
              {t('livePublic.haveAccount')}
            </Link>
          </p>
        </form>
      );
    }
  }

  return (
    <LivePublicShell>
      {offer.isLoading ? (
        <div className="grid place-items-center py-20">
          <Spinner />
        </div>
      ) : !o ? (
        <div className="card text-center">
          <span className="material-symbols-outlined text-5xl text-outline">event_busy</span>
          <p className="mt-2 font-heading text-lg font-bold">{t('guest.notFound')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('livePublic.notFoundHint')}</p>
        </div>
      ) : (
        <div className="card space-y-5">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-primary-text">{o.teacherName}</p>
              {status}
            </div>
            <h1 className="mt-1 font-heading text-2xl font-bold" dir="auto">
              {o.title}
            </h1>
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
              <p className="mt-3 whitespace-pre-line text-sm text-on-surface-variant" dir="auto">
                {o.description}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-2xl bg-primary-fixed/40 p-4">
            <span className="text-sm text-on-surface-variant">{free ? t('livePublic.entry') : t('liveBuy.seatPrice')}</span>
            <span className="font-heading text-3xl font-bold text-primary-text tabular-nums">
              {free ? t('liveBuy.free') : egp(o.studentPaysCents)}
            </span>
          </div>
          {!free && <RefundAndReplaySummary offer={o} />}

          {over ? (
            <p className="rounded-xl bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">{t('livePublic.overHint')}</p>
          ) : (
            action
          )}
        </div>
      )}

      {buying && o && (
        <LiveCheckoutModal
          open={buying}
          sessionId={id}
          title={o.title}
          onClose={() => {
            setBuying(false);
            qc.invalidateQueries({ queryKey: ['live-my-access', id] });
          }}
        />
      )}
    </LivePublicShell>
  );
}
