import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { resolveError } from '../../lib/errorMessage';
import {
  clientErrors,
  DURATION_PRESETS,
  firstInvalid,
  LIVE_SESSION_RULES,
  messageKey,
  serverErrors,
  toPayload,
  type LiveFormErrors,
  type LiveFormField,
  type LiveFormValues,
} from '../../lib/liveSessionForm';
import { Field } from '../../components/ui';

const EMPTY: LiveFormValues = {
  title: '',
  description: '',
  startsAt: '',
  durationMin: '60',
  capacity: '',
};

/** A small uppercase-free section heading: typography, not a box. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-1">
      <h4 className="mb-3 text-xs font-bold text-outline">{title}</h4>
      {children}
    </section>
  );
}

/**
 * Schedule a live session.
 *
 * Each field says what is wrong with it, under it — checked against the same
 * rules the server enforces, as the teacher leaves the field and again on
 * submit; whatever the server still refuses is put under its field too. The
 * banner at the bottom is only for what belongs to no field: the network, a
 * clash with another class, the server itself.
 */
export default function LiveSessionForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState<LiveFormValues>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<LiveFormField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<LiveFormErrors>({});
  const [useExternal, setUseExternal] = useState(false);
  const [joinUrl, setJoinUrl] = useState('');
  const refs = useRef<Partial<Record<LiveFormField, HTMLElement | null>>>({});

  const local = clientErrors(v);
  const shown = (f: LiveFormField) =>
    server[f] ?? ((submitted || touched[f]) && local[f] ? local[f] : undefined);

  const focusField = (f: LiveFormField | null) => {
    if (!f) return;
    const el = refs.current[f];
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el?.focus();
  };

  const create = useMutation({
    mutationFn: async () => (await api.post('/teacher/live', toPayload(v, joinUrl))).data,
    onSuccess: () => {
      setV(EMPTY);
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

  const set = (f: LiveFormField, value: string) => {
    setV((p) => ({ ...p, [f]: value }));
    // An edit answers the server's objection to that field.
    if (server[f]) setServer((p) => ({ ...p, [f]: undefined }));
  };

  const submit = () => {
    setSubmitted(true);
    const first = firstInvalid(local);
    if (first) return focusField(first);
    create.mutate();
  };

  // The banner: only what no field owns.
  const fieldOwned = create.error && Object.keys(serverErrors(create.error)).length > 0;
  const banner = create.error && !fieldOwned ? resolveError(create.error).message : null;

  const err = (f: LiveFormField) => {
    const p = shown(f);
    return p ? t(messageKey(p.code), p.params) : undefined;
  };
  const aria = (f: LiveFormField, hint = false) => {
    const e = !!shown(f);
    return {
      id: `live-${f}`,
      'aria-invalid': e || undefined,
      'aria-describedby': e ? `live-${f}-error` : hint ? `live-${f}-hint` : undefined,
      onBlur: () => setTouched((p) => ({ ...p, [f]: true })),
      ref: (el: HTMLElement | null) => (refs.current[f] = el),
    };
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
    >
      <Section title={t('live.form.basics')}>
        <Field label={t('live.fTitle')} id="live-title" error={err('title')}>
          <input
            className="input"
            dir="auto"
            maxLength={LIVE_SESSION_RULES.titleMax + 20}
            value={v.title}
            placeholder={t('live.fTitlePh')}
            onChange={(e) => set('title', e.target.value)}
            {...aria('title')}
          />
        </Field>
        <Field
          label={t('live.fDescription')}
          id="live-description"
          error={err('description')}
          className="mb-0"
        >
          <textarea
            className="input min-h-[4.5rem] resize-y"
            dir="auto"
            rows={2}
            value={v.description}
            placeholder={t('live.form.descriptionPh')}
            onChange={(e) => set('description', e.target.value)}
            {...aria('description')}
          />
        </Field>
      </Section>

      <Section title={t('live.form.schedule')}>
        <div className="grid gap-x-3 sm:grid-cols-[1.4fr_1fr]">
          <Field label={t('live.fStartsAt')} id="live-startsAt" error={err('startsAt')}>
            <input
              className="input"
              type="datetime-local"
              value={v.startsAt}
              onChange={(e) => set('startsAt', e.target.value)}
              {...aria('startsAt')}
            />
          </Field>
          <Field label={t('live.form.duration')} id="live-durationMin" error={err('durationMin')}>
            <div className="relative">
              <input
                className="input pe-16"
                inputMode="numeric"
                value={v.durationMin}
                onChange={(e) => set('durationMin', e.target.value.replace(/[^\d]/g, ''))}
                {...aria('durationMin')}
              />
              <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-sm text-outline">
                {t('live.form.minutesUnit')}
              </span>
            </div>
          </Field>
        </div>
        {/* The lengths teachers actually pick, one tap each. */}
        <div className="-mt-2 mb-1 flex flex-wrap gap-1.5" role="group" aria-label={t('live.fDuration')}>
          {DURATION_PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={v.durationMin === String(m)}
              onClick={() => set('durationMin', String(m))}
              className={`rounded-full border px-3 py-1 text-xs font-semibold tabular-nums transition-colors duration-150 ${
                v.durationMin === String(m)
                  ? 'border-primary bg-primary-fixed text-primary-text'
                  : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-low'
              }`}
            >
              {t('live.minutes', { count: m })}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('live.form.access')}>
        <Field
          label={t('live.fCapacity')}
          id="live-capacity"
          error={err('capacity')}
          hint={t('live.form.capacityHint')}
          className="mb-0"
        >
          <input
            className="input sm:max-w-[12rem]"
            inputMode="numeric"
            value={v.capacity}
            placeholder={t('live.form.unlimited')}
            onChange={(e) => set('capacity', e.target.value.replace(/[^\d]/g, ''))}
            {...aria('capacity', true)}
          />
        </Field>
      </Section>

      <Section title={t('live.form.liveSettings')}>
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary-fixed text-primary-text"
          >
            <span className="material-symbols-outlined text-[20px]">videocam</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{t('live.builtInTitle')}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-outline">{t('live.builtInHint')}</p>
            {!useExternal ? (
              <button
                type="button"
                className="mt-1.5 text-xs font-bold text-primary-text underline-offset-2 hover:underline"
                onClick={() => setUseExternal(true)}
              >
                {t('live.useExternal')}
              </button>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="input flex-1"
                  dir="ltr"
                  value={joinUrl}
                  onChange={(e) => setJoinUrl(e.target.value)}
                  placeholder="https://meet…"
                  aria-label={t('live.useExternal')}
                />
                <button
                  type="button"
                  aria-label={t('live.useBuiltIn')}
                  title={t('live.useBuiltIn')}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-on-surface-variant transition hover:bg-surface-container-low"
                  onClick={() => {
                    setUseExternal(false);
                    setJoinUrl('');
                  }}
                >
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </Section>

      {banner && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl bg-error-container px-4 py-2.5 text-sm text-on-error-container"
        >
          <span aria-hidden className="material-symbols-outlined text-[18px]">error</span>
          {banner}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn-primary sm:min-w-[9rem]" disabled={create.isPending}>
          {create.isPending ? t('common.saving') : t('live.publish')}
        </button>
      </div>
    </form>
  );
}
