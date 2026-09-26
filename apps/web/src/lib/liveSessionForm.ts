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
  code: LiveSessionFieldCode | 'INVALID';
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

export function clientErrors(v: LiveFormValues, now = Date.now()): LiveFormErrors {
  return toMap(
    validateLiveSession(
      {
        title: v.title,
        description: v.description,
        startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : '',
        durationMin: v.durationMin,
        capacity: v.capacity,
      },
      now,
    ),
  );
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

export function toPayload(v: LiveFormValues, joinUrl: string) {
  return {
    title: v.title.trim(),
    description: v.description.trim() || undefined,
    startsAt: new Date(v.startsAt).toISOString(),
    durationMin: Number(v.durationMin),
    capacity: v.capacity.trim() ? Number(v.capacity) : null,
    joinUrl: joinUrl.trim() || null,
  };
}
