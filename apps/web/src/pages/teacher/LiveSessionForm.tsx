import { useMutation } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { resolveError } from '../../lib/errorMessage';
import {
  clientErrors,
  combine,
  firstInvalid,
  formatTime12,
  LIVE_SESSION_RULES,
  localDate,
  localTime,
  messageKey,
  nextSlot,
  serverErrors,
  splitStart,
  startNowSlot,
  timeSlots,
  toPayload,
  type LiveFormErrors,
  type LiveFormField,
  type LiveFormValues,
} from '../../lib/liveSessionForm';
import { Field } from '../../components/ui';

const DURATIONS = [30, 45, 60, 90, 120];

function fresh(): LiveFormValues {
  // A class is usually "later today": the next half hour is the likeliest
  // answer, so most teachers only type a title.
  const at = nextSlot(Date.now());
  return { title: '', description: '', startsAt: combine(localDate(at), localTime(at)), durationMin: '60', capacity: '' };
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
      className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold tabular-nums transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 ${
        selected
          ? 'border-primary bg-primary text-on-primary'
          : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
      }`}
    >
      {children}
    </button>
  );
}

function Label({ children, htmlFor, error }: { children: ReactNode; htmlFor?: string; error?: boolean }) {
  return (
    <label htmlFor={htmlFor} className={`mb-2 block text-sm font-semibold ${error ? 'text-error' : 'text-on-surface-variant'}`}>
      {children}
    </label>
  );
}

function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1 text-sm text-error">
      <span aria-hidden className="material-symbols-outlined mt-px text-[18px]">error</span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Schedule a live session — as few decisions as possible.
 *
 * A title is the only thing most teachers type: the time starts at the next
 * half hour (with "now", "today" and "tomorrow" one tap away), the length at an
 * hour, the class unlimited. Each field is checked against the same rules the
 * server enforces and says what is wrong under itself; the server's own
 * refusals land under their fields too. A line above the button reads the
 * choice back before it is published.
 */
export default function LiveSessionForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [v, setV] = useState<LiveFormValues>(fresh);
  const [touched, setTouched] = useState<Partial<Record<LiveFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<LiveFormErrors>({});
  const [customLen, setCustomLen] = useState(false);
  const [limited, setLimited] = useState(false);
  const [joinUrl, setJoinUrl] = useState('');
  const refs = useRef<Partial<Record<LiveFormField, HTMLElement | null>>>({});

  const { date, time } = splitStart(v.startsAt);
  const today = localDate(Date.now());
  const tomorrow = localDate(Date.now() + 86_400_000);
  const slots = useMemo(() => timeSlots(15, time), [time]);

  const local = clientErrors(v);
  const shown = (f: LiveFormField) => server[f] ?? ((submitted || touched[f]) && local[f] ? local[f] : undefined);
  const err = (f: LiveFormField) => {
    const p = shown(f);
    return p ? t(messageKey(p.code), p.params) : undefined;
  };
  const a11y = (f: LiveFormField) => ({
    'aria-invalid': !!shown(f) || undefined,
    'aria-describedby': shown(f) ? `live-${f}-error` : undefined,
    onBlur: () => setTouched((p) => ({ ...p, [f]: true })),
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

  const set = (f: LiveFormField, value: string) => {
    setV((p) => ({ ...p, [f]: value }));
    if (server[f]) setServer((p) => ({ ...p, [f]: undefined }));
  };
  const setDate = (d: string) => set('startsAt', combine(d, time || localTime(nextSlot(Date.now()))));
  const setTime = (tm: string) => set('startsAt', combine(date || today, tm));

  const create = useMutation({
    mutationFn: async () =>
      (await api.post('/teacher/live', toPayload({ ...v, capacity: limited ? v.capacity : '' }, joinUrl))).data,
    onSuccess: () => {
      setV(fresh());
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
  });

  const submit = () => {
    setSubmitted(true);
    const first = firstInvalid(clientErrors({ ...v, capacity: limited ? v.capacity : '' }));
    if (first) return focusField(first);
    create.mutate();
  };

  const fieldOwned = create.error && Object.keys(serverErrors(create.error)).length > 0;
  const banner = create.error && !fieldOwned ? resolveError(create.error).message : null;

  // "Saturday 26 September · 7:30 PM · 1 hour"
  const readBack = (() => {
    const at = new Date(v.startsAt);
    if (!v.startsAt || Number.isNaN(at.getTime()) || local.durationMin) return null;
    const day = at.toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${day} · ${formatTime12(time, lang)} · ${t('live.minutes', { count: Number(v.durationMin) })}`;
  })();

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
          className={`input text-base ${shown('title') ? 'border-error' : ''}`}
          dir="auto"
          autoFocus
          maxLength={LIVE_SESSION_RULES.titleMax + 20}
          value={v.title}
          placeholder={t('live.fTitlePh')}
          onChange={(e) => set('title', e.target.value)}
          {...a11y('title')}
        />
        <FieldError id="live-title-error">{err('title')}</FieldError>
        <textarea
          id="live-description"
          ref={bind('description')}
          className={`input mt-3 min-h-[3.25rem] resize-y text-sm ${shown('description') ? 'border-error' : ''}`}
          dir="auto"
          rows={2}
          value={v.description}
          aria-label={t('live.fDescription')}
          placeholder={t('live.form.descriptionPh')}
          onChange={(e) => set('description', e.target.value)}
          {...a11y('description')}
        />
        <FieldError id="live-description-error">{err('description')}</FieldError>
      </div>

      {/* When */}
      <div>
        <Label error={!!shown('startsAt')}>{t('live.form.when')}</Label>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('live.form.when')}>
          <Chip
            selected={false}
            onClick={() => {
              const at = startNowSlot(Date.now());
              set('startsAt', combine(localDate(at), localTime(at)));
            }}
          >
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="material-symbols-outlined text-[16px]">bolt</span>
              {t('live.form.now')}
            </span>
          </Chip>
          <Chip selected={date === today} onClick={() => setDate(today)}>
            {t('live.form.today')}
          </Chip>
          <Chip selected={date === tomorrow} onClick={() => setDate(tomorrow)}>
            {t('live.form.tomorrow')}
          </Chip>
        </div>
        <div className="mt-3 grid grid-cols-[1.2fr_1fr] gap-2">
          <input
            id="live-startsAt"
            ref={bind('startsAt')}
            type="date"
            lang={lang}
            className={`input ${shown('startsAt') ? 'border-error' : ''}`}
            value={date}
            min={today}
            aria-label={t('live.form.date')}
            onChange={(e) => setDate(e.target.value)}
            {...a11y('startsAt')}
          />
          <select
            className={`input ${shown('startsAt') ? 'border-error' : ''}`}
            value={time}
            aria-label={t('live.form.time')}
            onChange={(e) => setTime(e.target.value)}
          >
            {slots.map((s) => (
              <option key={s} value={s}>
                {formatTime12(s, lang)}
              </option>
            ))}
          </select>
        </div>
        <FieldError id="live-startsAt-error">{err('startsAt')}</FieldError>
      </div>

      {/* How long */}
      <div>
        <Label error={!!shown('durationMin')}>{t('live.form.duration')}</Label>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('live.form.duration')}>
          {DURATIONS.map((m) => (
            <Chip
              key={m}
              selected={!customLen && v.durationMin === String(m)}
              onClick={() => {
                setCustomLen(false);
                set('durationMin', String(m));
              }}
            >
              {m === 60 ? t('live.form.hour') : m === 120 ? t('live.form.twoHours') : t('live.minutes', { count: m })}
            </Chip>
          ))}
          <Chip selected={customLen} onClick={() => setCustomLen(true)}>
            {t('live.form.custom')}
          </Chip>
        </div>
        {customLen && (
          <div className="relative mt-3 max-w-[12rem]">
            <input
              id="live-durationMin"
              ref={bind('durationMin')}
              className={`input pe-16 ${shown('durationMin') ? 'border-error' : ''}`}
              inputMode="numeric"
              autoFocus
              value={v.durationMin}
              aria-label={t('live.form.durationMinutes')}
              onChange={(e) => set('durationMin', e.target.value.replace(/[^\d]/g, ''))}
              {...a11y('durationMin')}
            />
            <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm text-outline">
              {t('live.form.minutesUnit')}
            </span>
          </div>
        )}
        <FieldError id="live-durationMin-error">{err('durationMin')}</FieldError>
      </div>

      {/* Who */}
      <div>
        <Label error={!!shown('capacity')}>{t('live.fCapacity')}</Label>
        <div className="flex flex-wrap items-center gap-2">
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
          {limited && (
            <input
              id="live-capacity"
              ref={bind('capacity')}
              className={`input w-28 ${shown('capacity') ? 'border-error' : ''}`}
              inputMode="numeric"
              value={v.capacity}
              placeholder="30"
              aria-label={t('live.form.maxStudents')}
              onChange={(e) => set('capacity', e.target.value.replace(/[^\d]/g, ''))}
              {...a11y('capacity')}
            />
          )}
        </div>
        <FieldError id="live-capacity-error">{err('capacity')}</FieldError>
      </div>

      {/* Advanced: where the class happens — Darsly's classroom unless told otherwise. */}
      <details className="group rounded-xl border border-outline-variant px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-on-surface-variant">
          <span aria-hidden className="material-symbols-outlined text-[20px] transition-transform group-open:rotate-90 rtl:group-open:-rotate-90">
            chevron_left
          </span>
          {t('live.form.advanced')}
        </summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-relaxed text-outline">{t('live.builtInHint')}</p>
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
        </div>
      </details>

      {banner && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container">
          <span aria-hidden className="material-symbols-outlined text-[18px]">error</span>
          {banner}
        </p>
      )}

      <div className="border-t border-outline-variant pt-4">
        {readBack && (
          <p className="mb-3 flex items-center gap-2 text-sm text-on-surface-variant">
            <span aria-hidden className="material-symbols-outlined text-[18px] text-primary-text">event_available</span>
            {readBack}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary sm:min-w-[9rem]" disabled={create.isPending}>
            {create.isPending ? t('common.saving') : t('live.publish')}
          </button>
        </div>
      </div>
    </form>
  );
}
