import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { resolveError } from '../../lib/errorMessage';
import {
  asciiDigits,
  clientErrors,
  commerceErrors,
  clockSkew,
  combine,
  firstInvalid,
  formatDuration,
  formatTime12,
  LIVE_SESSION_RULES,
  localDate,
  localTime,
  messageKey,
  nextSlot,
  serverErrors,
  toPayload,
  type LiveFormErrors,
  type LiveFormField,
  type LiveFormValues,
} from '../../lib/liveSessionForm';
import { Field } from '../../components/ui';
import { egp } from '../../lib/format';
import {
  LIVE_REFUND_POLICIES,
  LIVE_REFUND_WINDOW_HOURS,
  parseMoneyToCents,
  type LiveRefundPolicy,
  type LiveReplayPolicy,
} from '@darsly/shared-types';

type TranscriptionMode = 'OFF' | 'MANUAL' | 'AUTO_WHEN_RECORDING';
/** "now" = start the moment it is created; "pick" = the date and time shown. */
type WhenMode = 'now' | 'pick';

const DURATIONS = [30, 45, 60, 90, 120];
/** What "tomorrow" means when the time shown is not one the teacher chose. */
const TOMORROW_DEFAULT_TIME = '19:00';

interface Draft {
  title: string;
  description: string;
  date: string;
  time: string;
  durationMin: string;
  capacity: string;
}

function fresh(): Draft {
  // A class is usually "later today": the next half hour is the likeliest
  // answer, so most teachers only type a title.
  const at = nextSlot(Date.now());
  return {
    title: '',
    description: '',
    date: localDate(at),
    time: localTime(at),
    durationMin: '60',
    capacity: '',
  };
}

/** One choice among a few, as buttons rather than a dropdown. */
function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-[2.5rem] rounded-full border px-4 py-1.5 text-sm font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 focus-visible:ring-offset-1 ${
        selected
          ? 'border-primary bg-primary text-on-primary shadow-sm'
          : 'border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:border-outline hover:bg-surface-container-low'
      }`}
    >
      {children}
    </button>
  );
}

function Label({
  children,
  htmlFor,
  id,
  error,
}: {
  children: ReactNode;
  htmlFor?: string;
  id?: string;
  error?: boolean;
}) {
  return (
    <label
      id={id}
      htmlFor={htmlFor}
      className={`mb-2 block text-sm font-semibold ${error ? 'text-error' : 'text-on-surface-variant'}`}
    >
      {children}
    </label>
  );
}

function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1 text-sm text-error">
      <span aria-hidden className="material-symbols-outlined mt-px text-[18px]">
        error
      </span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Schedule a live session — as few decisions as possible.
 *
 * A title is the only thing most teachers type: the time starts at the next
 * half hour ("now" and "tomorrow" one tap away, any minute typed by hand), the
 * length at an hour, the class unlimited. Each field is checked against the
 * same rules the server enforces, but only once the teacher has typed in it
 * and left, or tried to create — never an error for a field not yet reached.
 * A line above the button reads the choice back before it is created.
 */
export default function LiveSessionForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const uid = useId();
  const [d, setD] = useState<Draft>(fresh);
  const [whenMode, setWhenMode] = useState<WhenMode>('pick');
  const [dirty, setDirty] = useState<Partial<Record<LiveFormField, boolean>>>({});
  const [touched, setTouched] = useState<Partial<Record<LiveFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<LiveFormErrors>({});
  const [customLen, setCustomLen] = useState(false);
  const [limited, setLimited] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [joinUrl, setJoinUrl] = useState('');
  // FREE by default; PAID is a deliberate choice with its own few settings.
  const [paid, setPaid] = useState(false);
  const [price, setPrice] = useState('');
  const [refundPolicy, setRefundPolicy] = useState<LiveRefundPolicy>('STANDARD');
  const [replayPolicy, setReplayPolicy] = useState<LiveReplayPolicy>('INCLUDED_FOREVER');
  const [replayDays, setReplayDays] = useState('7');
  // One request at a time, whatever the button's state says: a double click
  // lands before React re-renders it disabled.
  const inFlight = useRef(false);
  // Offered only when the platform transcribes at all; also carries the
  // server's clock, so a device set a few minutes wrong still means "now".
  const features = useQuery({
    queryKey: ['live-features'],
    queryFn: async () => {
      const data = (await api.get('/teacher/live-features')).data as {
        transcription: boolean;
        defaultTranscriptionMode: TranscriptionMode;
        serverNow?: string;
      };
      return { ...data, skew: clockSkew(data.serverNow, Date.now()) };
    },
    staleTime: 5 * 60_000,
  });
  // The server's own breakdown of the price being typed, a moment after the
  // typing stops — never computed here, because the terms are not the page's.
  const priceCents = paid ? parseMoneyToCents(price) : null;
  const [previewFor, setPreviewFor] = useState<number | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setPreviewFor(priceCents), 400);
    return () => clearTimeout(h);
  }, [priceCents]);
  const preview = useQuery({
    queryKey: ['live-price-preview', previewFor],
    queryFn: async () =>
      (await api.get('/teacher/live/price-preview', { params: { priceCents: previewFor } })).data,
    enabled: paid && previewFor != null && previewFor >= 100,
    retry: false,
  });
  const skew = features.data?.skew ?? 0;
  const nowMs = () => Date.now() + skew;
  const [mode, setMode] = useState<TranscriptionMode | null>(null);
  const transcriptionMode = mode ?? features.data?.defaultTranscriptionMode ?? null;
  const refs = useRef<Partial<Record<LiveFormField, HTMLElement | null>>>({});

  const today = localDate(nowMs());
  const tomorrow = localDate(nowMs() + 86_400_000);

  /** The values as they would be sent right now ("now" is read at this instant). */
  const values = (): LiveFormValues => {
    const at = nowMs();
    return {
      title: d.title,
      description: d.description,
      startsAt:
        whenMode === 'now' ? combine(localDate(at), localTime(at)) : combine(d.date, d.time),
      durationMin: d.durationMin,
      capacity: limited ? d.capacity : '',
    };
  };
  const commerce = () => ({ paid, price, replayPolicy, replayDays });
  const local = {
    ...clientErrors(values(), nowMs(), { capacityRequired: limited }),
    ...commerceErrors(commerce()),
  };
  const shown = (f: LiveFormField) =>
    server[f] ?? ((submitted || touched[f]) && local[f] ? local[f] : undefined);
  const err = (f: LiveFormField) => {
    const p = shown(f);
    return p ? t(messageKey(p.code), p.params) : undefined;
  };
  const errorId = (f: LiveFormField) => `${uid}-${f}-error`;
  const a11y = (f: LiveFormField) => ({
    'aria-invalid': !!shown(f) || undefined,
    'aria-describedby': shown(f) ? errorId(f) : undefined,
    // Leaving an untouched field says nothing; leaving one typed in checks it.
    onBlur: () => {
      if (dirty[f]) setTouched((p) => ({ ...p, [f]: true }));
    },
  });
  const bind = (f: LiveFormField) => (el: HTMLElement | null) => {
    refs.current[f] = el;
  };
  const focusField = (f: LiveFormField | null) => {
    if (!f) return;
    const el = refs.current[f];
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el?.focus();
  };

  const touch = (f: LiveFormField, value: Partial<Draft>, checkNow = false) => {
    setD((p) => ({ ...p, ...value }));
    setDirty((p) => ({ ...p, [f]: true }));
    if (checkNow) setTouched((p) => ({ ...p, [f]: true }));
    if (server[f]) setServer((p) => ({ ...p, [f]: undefined }));
  };
  // A date or time is a pick, not typing: say at once if it has passed.
  const pickDate = (date: string) => {
    setWhenMode('pick');
    touch('startsAt', { date }, true);
  };
  const pickTime = (time: string) => {
    setWhenMode('pick');
    touch('startsAt', { time, date: d.date || today }, true);
  };
  const chooseNow = () => {
    const at = nowMs();
    setWhenMode('now');
    touch('startsAt', { date: localDate(at), time: localTime(at) }, true);
  };
  const chooseTomorrow = () => {
    setWhenMode('pick');
    // Keep a time the teacher picked; "now"'s minute is not one.
    touch(
      'startsAt',
      { date: tomorrow, time: whenMode === 'now' || !d.time ? TOMORROW_DEFAULT_TIME : d.time },
      true,
    );
  };

  const create = useMutation({
    mutationFn: async (payload: Record<string, unknown>) =>
      (await api.post('/teacher/live', payload)).data,
    onSuccess: () => {
      setD(fresh());
      setPaid(false);
      setPrice('');
      setWhenMode('pick');
      setDirty({});
      setTouched({});
      setSubmitted(false);
      setServer({});
      onCreated();
    },
    onError: (e) => {
      const byField = serverErrors(e);
      setServer(byField);
      focusField(firstInvalid(byField));
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const submit = () => {
    if (inFlight.current) return;
    setSubmitted(true);
    const v = values();
    const first = firstInvalid({
      ...clientErrors(v, nowMs(), { capacityRequired: limited }),
      ...commerceErrors(commerce()),
    });
    if (first) return focusField(first);
    inFlight.current = true;
    const payload: Record<string, unknown> = {
      ...toPayload(v, joinUrl),
      // "Now" is the server's now: the device clock may be off by minutes.
      ...(whenMode === 'now' ? { startsAt: new Date(nowMs()).toISOString() } : {}),
      ...(features.data?.transcription && transcriptionMode ? { transcriptionMode } : {}),
      // What a seat costs, and the rules a buyer gets — never Darsly's fee or
      // a split: those are the academy's terms, applied by the server.
      ...(paid
        ? {
            accessMode: 'PAID',
            priceCents: parseMoneyToCents(price),
            refundPolicy,
            replayPolicy,
            replayDays: replayPolicy === 'INCLUDED_DAYS' ? Number(replayDays) : null,
            joinUrl: null,
          }
        : { accessMode: 'FREE' }),
    };
    create.mutate(payload);
  };

  const fieldOwned = create.error && Object.keys(serverErrors(create.error)).length > 0;
  const banner = create.error && !fieldOwned ? resolveError(create.error).message : null;

  const durationOk = !local.durationMin;
  const duration = durationOk ? formatDuration(Number(d.durationMin), t) : null;
  // "السبت 26 سبتمبر • 9:37 م • ساعة و10 دقائق"
  const readBack = (() => {
    if (!duration) return null;
    if (whenMode === 'now') return `${t('live.form.startsNow')} • ${duration}`;
    const at = new Date(combine(d.date, d.time));
    if (Number.isNaN(at.getTime()) || local.startsAt) return null;
    const day = at.toLocaleDateString(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    return `${day} • ${formatTime12(d.time, lang)} • ${duration}`;
  })();

  const inputCls = (f: LiveFormField) => `input ${shown(f) ? 'border-error' : ''}`;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-6"
    >
      {/* What */}
      <div>
        <Label htmlFor="live-title" error={!!shown('title')}>
          {t('live.fTitle')}
        </Label>
        <input
          id="live-title"
          ref={bind('title')}
          className={`${inputCls('title')} text-base`}
          dir="auto"
          autoFocus
          maxLength={LIVE_SESSION_RULES.titleMax + 20}
          value={d.title}
          placeholder={t('live.fTitlePh')}
          onChange={(e) => touch('title', { title: e.target.value })}
          {...a11y('title')}
        />
        <FieldError id={errorId('title')}>{err('title')}</FieldError>
        <label
          htmlFor="live-description"
          className="mb-2 mt-4 block text-sm font-semibold text-on-surface-variant"
        >
          {t('live.fDescription')}{' '}
          <span className="font-normal text-outline">({t('common.optional')})</span>
        </label>
        <textarea
          id="live-description"
          ref={bind('description')}
          className={`${inputCls('description')} min-h-[3.25rem] resize-y text-sm`}
          dir="auto"
          rows={2}
          value={d.description}
          placeholder={t('live.form.descriptionPh')}
          onChange={(e) => touch('description', { description: e.target.value })}
          {...a11y('description')}
        />
        <FieldError id={errorId('description')}>{err('description')}</FieldError>
      </div>

      {/* Free or paid — FREE unless the teacher chooses otherwise. */}
      <div role="group" aria-labelledby={`${uid}-access`}>
        <Label id={`${uid}-access`}>{t('liveCommerce.sessionType')}</Label>
        <div className="flex flex-wrap gap-2">
          <Chip selected={!paid} onClick={() => setPaid(false)}>
            {t('liveCommerce.free')}
          </Chip>
          <Chip
            selected={paid}
            onClick={() => {
              setPaid(true);
              setJoinUrl('');
              setTimeout(() => refs.current.priceCents?.focus(), 0);
            }}
          >
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="material-symbols-outlined text-[16px]">
                payments
              </span>
              {t('liveCommerce.paid')}
            </span>
          </Chip>
        </div>
        {paid && (
          <div className="mt-4 space-y-4 rounded-2xl border border-outline-variant p-4">
            <div>
              <label
                htmlFor="live-price"
                className={`mb-1.5 block text-sm font-semibold ${shown('priceCents') ? 'text-error' : 'text-on-surface-variant'}`}
              >
                {t('liveCommerce.price')}
              </label>
              <div className="relative w-48" dir="ltr">
                <input
                  id="live-price"
                  ref={bind('priceCents')}
                  className={`${inputCls('priceCents')} pe-14 tabular-nums`}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="100"
                  value={price}
                  onChange={(e) => {
                    setPrice(asciiDigits(e.target.value).replace(/\u066B/g, '.'));
                    setDirty((p2) => ({ ...p2, priceCents: true }));
                    if (server.priceCents) setServer((p2) => ({ ...p2, priceCents: undefined }));
                  }}
                  {...a11y('priceCents')}
                />
                <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm text-outline">
                  {t('liveCommerce.egp')}
                </span>
              </div>
              <FieldError id={errorId('priceCents')}>{err('priceCents')}</FieldError>
              {/* The server's breakdown under the academy's current terms. */}
              {!local.priceCents && preview.data && previewFor === priceCents && (
                <dl
                  className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-surface-container-low p-3 text-sm"
                  aria-live="polite"
                >
                  <dt className="text-on-surface-variant">{t('liveCommerce.preview.price')}</dt>
                  <dd className="text-end tabular-nums">{egp(preview.data.priceCents)}</dd>
                  <dt className="text-on-surface-variant">{t('liveCommerce.preview.fee')}</dt>
                  <dd className="text-end tabular-nums">
                    {preview.data.feeMode === 'DEDUCTED' ? '−' : '+'}
                    {egp(preview.data.feeCents)}
                  </dd>
                  <dt className="font-semibold">{t('liveCommerce.preview.studentPays')}</dt>
                  <dd className="text-end font-semibold tabular-nums">
                    {egp(preview.data.studentPaysCents)}
                  </dd>
                  <dt className="font-semibold text-primary-text">
                    {t('liveCommerce.preview.teacherNet')}
                  </dt>
                  <dd className="text-end font-semibold text-primary-text tabular-nums">
                    {egp(preview.data.teacherCents)}
                  </dd>
                  {preview.data.kind === 'CENTER' && (
                    <>
                      <dt className="text-on-surface-variant">
                        {t('liveCommerce.preview.centerShare')}
                      </dt>
                      <dd className="text-end tabular-nums">{egp(preview.data.centerCents)}</dd>
                    </>
                  )}
                </dl>
              )}
              {preview.error && !local.priceCents ? (
                <p className="mt-2 text-sm text-error" role="alert">
                  {resolveError(preview.error).message}
                </p>
              ) : null}
            </div>

            <div role="group" aria-labelledby={`${uid}-refund`}>
              <p
                id={`${uid}-refund`}
                className="mb-2 text-sm font-semibold text-on-surface-variant"
              >
                {t('liveCommerce.refundPolicy')}
              </p>
              <div className="flex flex-wrap gap-2">
                {LIVE_REFUND_POLICIES.map((rp) => (
                  <Chip key={rp} selected={refundPolicy === rp} onClick={() => setRefundPolicy(rp)}>
                    {t(`liveCommerce.refund.${rp}`)}
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-outline">
                {LIVE_REFUND_WINDOW_HOURS[refundPolicy] == null
                  ? t('liveBuy.refund.none')
                  : (LIVE_REFUND_WINDOW_HOURS[refundPolicy] as number) >= 48
                    ? t('liveBuy.refund.days', {
                        count: Math.round((LIVE_REFUND_WINDOW_HOURS[refundPolicy] as number) / 24),
                      })
                    : t('liveBuy.refund.hours', {
                        count: LIVE_REFUND_WINDOW_HOURS[refundPolicy] as number,
                      })}
              </p>
            </div>

            <div role="group" aria-labelledby={`${uid}-replay`}>
              <p
                id={`${uid}-replay`}
                className="mb-2 text-sm font-semibold text-on-surface-variant"
              >
                {t('liveCommerce.replayPolicy')}
              </p>
              <div className="flex flex-wrap gap-2">
                {(['INCLUDED_FOREVER', 'INCLUDED_DAYS', 'NONE'] as const).map((rp) => (
                  <Chip key={rp} selected={replayPolicy === rp} onClick={() => setReplayPolicy(rp)}>
                    {t(`liveCommerce.replay.${rp}`)}
                  </Chip>
                ))}
              </div>
              {replayPolicy === 'INCLUDED_DAYS' && (
                <div className="mt-3 w-40">
                  <label
                    htmlFor="live-replay-days"
                    className="mb-1.5 block text-xs font-semibold text-on-surface-variant"
                  >
                    {t('liveCommerce.replayDays')}
                  </label>
                  <input
                    id="live-replay-days"
                    ref={bind('replayDays')}
                    className={`${inputCls('replayDays')} tabular-nums`}
                    inputMode="numeric"
                    value={replayDays}
                    onChange={(e) => {
                      setReplayDays(asciiDigits(e.target.value));
                      setDirty((p2) => ({ ...p2, replayDays: true }));
                    }}
                    {...a11y('replayDays')}
                  />
                  <FieldError id={errorId('replayDays')}>{err('replayDays')}</FieldError>
                </div>
              )}
              <p className="mt-1.5 text-xs text-outline">{t('liveCommerce.replayNeedsSharing')}</p>
            </div>
          </div>
        )}
      </div>

      {/* When */}
      <div role="group" aria-labelledby={`${uid}-when`}>
        <Label id={`${uid}-when`} error={!!shown('startsAt')}>
          {t('live.form.when')}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Chip selected={whenMode === 'now'} onClick={chooseNow}>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="material-symbols-outlined text-[16px]">
                bolt
              </span>
              {t('live.form.now')}
            </span>
          </Chip>
          <Chip selected={whenMode === 'pick' && d.date === tomorrow} onClick={chooseTomorrow}>
            {t('live.form.tomorrow')}
          </Chip>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1.25fr_1fr]">
          <input
            id="live-startsAt"
            ref={bind('startsAt')}
            type="date"
            lang={lang}
            className={inputCls('startsAt')}
            value={d.date}
            min={today}
            aria-label={t('live.form.date')}
            onChange={(e) => pickDate(e.target.value)}
            {...a11y('startsAt')}
          />
          <input
            id="live-time"
            type="time"
            step={60}
            dir="ltr"
            lang={lang}
            className={`${inputCls('startsAt')} tabular-nums`}
            value={d.time}
            aria-label={t('live.form.time')}
            onChange={(e) => pickTime(e.target.value)}
            {...a11y('startsAt')}
          />
        </div>
        {whenMode === 'now' && !shown('startsAt') && (
          <p className="mt-1.5 flex items-center gap-1 text-sm text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-[16px] text-primary-text">
              bolt
            </span>
            {t('live.form.nowHint')}
          </p>
        )}
        <FieldError id={errorId('startsAt')}>{err('startsAt')}</FieldError>
      </div>

      {/* How long */}
      <div role="group" aria-labelledby={`${uid}-duration`}>
        <Label id={`${uid}-duration`} error={!!shown('durationMin')}>
          {t('live.form.duration')}
        </Label>
        <div className="flex flex-wrap gap-2">
          {DURATIONS.map((m) => (
            <Chip
              key={m}
              selected={!customLen && d.durationMin === String(m)}
              onClick={() => {
                setCustomLen(false);
                touch('durationMin', { durationMin: String(m) });
              }}
            >
              {m === 60
                ? t('live.form.hour')
                : m === 120
                  ? t('live.form.twoHours')
                  : t('live.minutes', { count: m })}
            </Chip>
          ))}
          <Chip
            selected={customLen}
            onClick={() => {
              setCustomLen(true);
              setTimeout(() => refs.current.durationMin?.focus(), 0);
            }}
          >
            {t('live.form.custom')}
          </Chip>
        </div>
        {customLen && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="relative w-40">
              <input
                id="live-durationMin"
                ref={bind('durationMin')}
                className={`${inputCls('durationMin')} pe-16 tabular-nums`}
                inputMode="numeric"
                value={d.durationMin}
                aria-label={t('live.form.durationMinutes')}
                onChange={(e) => touch('durationMin', { durationMin: asciiDigits(e.target.value) })}
                {...a11y('durationMin')}
              />
              <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm text-outline">
                {t('live.form.minutesUnit')}
              </span>
            </div>
            {duration && (
              <span className="text-sm font-semibold text-on-surface-variant" aria-live="polite">
                = {duration}
              </span>
            )}
          </div>
        )}
        <FieldError id={errorId('durationMin')}>{err('durationMin')}</FieldError>
      </div>

      {/* Who */}
      <div role="group" aria-labelledby={`${uid}-capacity`}>
        <Label id={`${uid}-capacity`} error={!!shown('capacity')}>
          {t('live.fCapacity')}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Chip selected={!limited} onClick={() => setLimited(false)}>
            {t('live.form.unlimited')}
          </Chip>
          <Chip
            selected={limited}
            onClick={() => {
              setLimited(true);
              setTimeout(() => refs.current.capacity?.focus(), 0);
            }}
          >
            {t('live.form.limit')}
          </Chip>
        </div>
        {limited && (
          <div className="mt-3 w-40">
            <label
              htmlFor="live-capacity"
              className="mb-1.5 block text-xs font-semibold text-on-surface-variant"
            >
              {t('live.form.maxStudents')}
            </label>
            <input
              id="live-capacity"
              ref={bind('capacity')}
              className={`${inputCls('capacity')} tabular-nums`}
              inputMode="numeric"
              value={d.capacity}
              placeholder="30"
              onChange={(e) => touch('capacity', { capacity: asciiDigits(e.target.value) })}
              {...a11y('capacity')}
            />
          </div>
        )}
        <FieldError id={errorId('capacity')}>{err('capacity')}</FieldError>
      </div>

      {/* Advanced: where the class happens — Darsly's classroom unless told otherwise. */}
      <div className="rounded-xl border border-outline-variant">
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls={`${uid}-advanced`}
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-start text-sm font-semibold text-on-surface-variant hover:bg-surface-container-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600"
        >
          <span aria-hidden className="material-symbols-outlined text-[20px]">
            {advancedOpen ? 'expand_more' : i18n.dir() === 'rtl' ? 'chevron_left' : 'chevron_right'}
          </span>
          {t('live.form.advanced')}
        </button>
        {advancedOpen && (
          <div id={`${uid}-advanced`} className="space-y-2 px-4 pb-4">
            {features.data?.transcription && transcriptionMode && (
              <Field label={t('live.form.transcription')} id="live-transcription" className="mb-3">
                <select
                  id="live-transcription"
                  className="input"
                  value={transcriptionMode}
                  onChange={(e) => setMode(e.target.value as TranscriptionMode)}
                >
                  {(['AUTO_WHEN_RECORDING', 'MANUAL', 'OFF'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`record.transcript.mode.${m}`)}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs leading-relaxed text-outline">
                  {t('live.form.transcriptionHint')}
                </p>
              </Field>
            )}
            <p className="text-xs leading-relaxed text-outline">{t('live.builtInHint')}</p>
            {/* A paid seat is enforced by Darsly's own classroom — no outside link. */}
            {!paid && (
              <Field label={t('live.useExternal')} id="live-joinUrl" className="mb-0">
                <input
                  id="live-joinUrl"
                  className="input"
                  dir="ltr"
                  value={joinUrl}
                  onChange={(e) => setJoinUrl(e.target.value)}
                  placeholder="https://meet…"
                />
              </Field>
            )}
          </div>
        )}
      </div>

      {banner && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container"
        >
          <span aria-hidden className="material-symbols-outlined text-[18px]">
            error
          </span>
          {banner}
        </p>
      )}

      {/* Stays in reach however far the form scrolls. The dialog pads by p-6 and
          sticky stops at that padding, hence -bottom-6 to sit flush on its edge. */}
      <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 border-t border-outline-variant bg-surface-container-lowest px-6 pb-6 pt-4">
        {readBack && (
          <p
            className="mb-3 flex items-center gap-2 text-sm font-medium text-on-surface"
            aria-live="polite"
          >
            <span aria-hidden className="material-symbols-outlined text-[18px] text-primary-text">
              event_available
            </span>
            <span className="tabular-nums">{readBack}</span>
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="btn-primary inline-flex items-center justify-center gap-2 sm:min-w-[10rem]"
            disabled={create.isPending}
            aria-busy={create.isPending || undefined}
          >
            {create.isPending && (
              <span
                aria-hidden
                className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary"
              />
            )}
            {create.isPending ? t('live.form.creating') : t('live.form.create')}
          </button>
        </div>
      </div>
    </form>
  );
}
