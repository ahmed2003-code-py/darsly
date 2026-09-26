import {
  LIVE_SESSION_RULES,
  validateLiveSession,
  type LiveSessionFieldCode,
  type LiveSessionFieldError,
} from '@darsly/shared-types';

/**
 * The "new live session" form's logic, apart from its markup.
 *
 * The rules are LIVE_SESSION_RULES — the very ones the API enforces — so the
 * form refuses what the server would, field by field, before a round trip. The
 * server stays the authority: whatever it refuses comes back as
 * `fields: [{ field, code, params }]` and lands under the same field.
 */
export type LiveFormField = 'title' | 'description' | 'startsAt' | 'durationMin' | 'capacity';
/** Form order — the first invalid one is where focus goes. */
export const LIVE_FORM_ORDER: LiveFormField[] = [
  'title',
  'description',
  'startsAt',
  'durationMin',
  'capacity',
];

export interface LiveFormValues {
  title: string;
  description: string;
  /** `datetime-local` value (local time, no zone). */
  startsAt: string;
  durationMin: string;
  capacity: string;
}

export interface FieldProblem {
  /** CAPACITY_REQUIRED is the form's own: "limit" chosen but no number typed. */
  code: LiveSessionFieldCode | 'CAPACITY_REQUIRED' | 'INVALID';
  params: Record<string, number>;
}
export type LiveFormErrors = Partial<Record<LiveFormField, FieldProblem>>;

export const DURATION_PRESETS = [45, 60, 90, 120];
export { LIVE_SESSION_RULES };

/** i18n key for a refusal: `live.v.<CODE>`, with `{{min}}` / `{{max}}` params. */
export const messageKey = (code: FieldProblem['code']) => `live.v.${code}`;

function toMap(errors: LiveSessionFieldError[]): LiveFormErrors {
  const out: LiveFormErrors = {};
  for (const e of errors) out[e.field] ??= { code: e.code, params: e.params ?? {} };
  return out;
}

/**
 * The form is stricter about the past than the server: the server forgives a
 * few minutes (a slow submit, a clock a little behind), but a teacher picking a
 * time must not be offered one that has already gone — anything before the
 * current minute is refused. `now` should be server time (see `clockSkew`).
 */
export function clientErrors(
  v: LiveFormValues,
  now = Date.now(),
  opts: { capacityRequired?: boolean } = {},
): LiveFormErrors {
  const minuteStart = now - (now % 60_000);
  const out = toMap(
    validateLiveSession(
      {
        title: v.title,
        description: v.description,
        startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : '',
        durationMin: v.durationMin,
        capacity: v.capacity,
      },
      minuteStart + LIVE_SESSION_RULES.pastGraceMin * 60_000,
    ),
  );
  if (opts.capacityRequired && !v.capacity.trim()) out.capacity ??= { code: 'CAPACITY_REQUIRED', params: {} };
  return out;
}

/** Arabic-Indic / Persian digits → ASCII, so "٧٠" means 70. Nothing else is touched. */
export const asciiDigits = (s: string) =>
  s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) & 0xf));

/** How far the device clock is behind the server's (ms): add it to Date.now(). */
export function clockSkew(serverNowIso: string | undefined, receivedAt: number): number {
  const server = serverNowIso ? new Date(serverNowIso).getTime() : NaN;
  if (!Number.isFinite(server)) return 0;
  const skew = server - receivedAt;
  // Under a minute is network noise, not a wrong clock.
  return Math.abs(skew) < 60_000 ? 0 : skew;
}

type T = (key: string, opts?: Record<string, unknown>) => string;
/** 70 → "ساعة و10 دقائق" / "1 hour 10 min"; 45 → "45 دقيقة"; 120 → "ساعتين". */
export function formatDuration(min: number, t: T): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return t('live.minutes', { count: m });
  const hours = t('live.dur.hours', { count: h });
  return m ? t('live.dur.join', { h: hours, m: t('live.minutes', { count: m }) }) : hours;
}

/**
 * What the server refused, by field. Anything it refused that is not about a
 * field (a clash with another class, the network) is left to the banner.
 */
export function serverErrors(error: unknown): LiveFormErrors {
  const data = (error as { response?: { data?: { fields?: unknown; message?: unknown } } } | null)
    ?.response?.data;
  const out: LiveFormErrors = {};
  if (Array.isArray(data?.fields)) {
    for (const f of data.fields as { field?: unknown; code?: unknown; params?: unknown }[]) {
      if (typeof f?.field !== 'string' || !LIVE_FORM_ORDER.includes(f.field as LiveFormField)) continue;
      out[f.field as LiveFormField] ??= {
        code: (typeof f.code === 'string' ? f.code : 'INVALID') as FieldProblem['code'],
        params: (f.params && typeof f.params === 'object' ? f.params : {}) as Record<string, number>,
      };
    }
  } else if (Array.isArray(data?.message)) {
    // The DTO's own refusals (shape only): the property name is the first word.
    for (const m of data.message) {
      const field = typeof m === 'string' ? m.split(/\s/)[0] : '';
      if (LIVE_FORM_ORDER.includes(field as LiveFormField))
        out[field as LiveFormField] ??= { code: 'INVALID', params: {} };
    }
  }
  return out;
}

export function firstInvalid(errors: LiveFormErrors): LiveFormField | null {
  return LIVE_FORM_ORDER.find((f) => errors[f]) ?? null;
}

/* ── Scheduling helpers (local time, as the teacher reads the clock) ──────── */

const pad = (n: number) => String(n).padStart(2, '0');
export const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const localTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** The next round slot: what "a class later today" usually means. */
export function nextSlot(now: number, stepMin = 30): number {
  const step = stepMin * 60_000;
  return Math.ceil((now + 60_000) / step) * step;
}
export const combine = (date: string, time: string) => (date && time ? `${date}T${time}` : '');
export function splitStart(startsAt: string): { date: string; time: string } {
  const [date = '', time = ''] = startsAt.split('T');
  return { date, time: time.slice(0, 5) };
}
/** "19:30" → "7:30 م" / "7:30 PM". */
export function formatTime12(time: string, lang: string): string {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const h12 = h % 12 || 12;
  const pm = h >= 12;
  return `${h12}:${pad(m)} ${lang === 'ar' ? (pm ? 'م' : 'ص') : pm ? 'PM' : 'AM'}`;
}

export function toPayload(v: LiveFormValues, joinUrl: string) {
  return {
    title: v.title.trim(),
    description: v.description.trim() || undefined,
    // `startsAt` is local wall-clock ("2026-09-26T21:37", no zone), which
    // `new Date` reads as local time: one conversion, to UTC, here and only here.
    startsAt: new Date(v.startsAt).toISOString(),
    durationMin: Number(v.durationMin),
    capacity: v.capacity.trim() ? Number(v.capacity) : null,
    joinUrl: joinUrl.trim() || null,
  };
}
