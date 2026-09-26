/**
 * The rules for scheduling a live session — one copy, read by both sides.
 *
 * The API enforces them (DTO bounds + LiveService.create); the form mirrors
 * them so a teacher is told which field is wrong the moment they leave it,
 * instead of after a round trip. Change a number here and both move together.
 */
export const LIVE_SESSION_RULES = {
  titleMin: 2,
  titleMax: 160,
  descriptionMax: 1000,
  durationMin: 5,
  durationMax: 720,
  capacityMin: 1,
  capacityMax: 100_000,
  /**
   * How far in the past a start time may be and still be accepted: "now",
   * typed a minute ago on a device whose clock is a little behind.
   */
  pastGraceMin: 5,
} as const;

/** Field-level refusal codes; the web maps each to one Arabic sentence. */
export type LiveSessionFieldCode =
  | 'TITLE_REQUIRED'
  | 'TITLE_TOO_SHORT'
  | 'TITLE_TOO_LONG'
  | 'DESCRIPTION_TOO_LONG'
  | 'STARTS_AT_REQUIRED'
  | 'STARTS_AT_INVALID'
  | 'STARTS_AT_PAST'
  | 'DURATION_INVALID'
  | 'DURATION_TOO_SHORT'
  | 'DURATION_TOO_LONG'
  | 'CAPACITY_INVALID'
  | 'CAPACITY_TOO_SMALL'
  | 'CAPACITY_TOO_LARGE';

export interface LiveSessionFieldError {
  field: 'title' | 'description' | 'startsAt' | 'durationMin' | 'capacity';
  code: LiveSessionFieldCode;
  params?: Record<string, number>;
}

export interface LiveSessionInput {
  title?: string | null;
  description?: string | null;
  /** ISO string, or anything `new Date()` understands. */
  startsAt?: string | null;
  durationMin?: number | string | null;
  /** Empty / null = unlimited. */
  capacity?: number | string | null;
}

const isWholeNumber = (v: unknown) =>
  (typeof v === 'number' && Number.isInteger(v)) ||
  (typeof v === 'string' && /^\d+$/.test(v.trim()));

/**
 * Every field that breaks a rule, in form order — the first one is where the
 * cursor should go. `now` is injectable so both sides and the tests agree.
 */
export function validateLiveSession(
  input: LiveSessionInput,
  now: number = Date.now(),
): LiveSessionFieldError[] {
  const R = LIVE_SESSION_RULES;
  const out: LiveSessionFieldError[] = [];

  const title = (input.title ?? '').trim();
  if (!title) out.push({ field: 'title', code: 'TITLE_REQUIRED' });
  else if (title.length < R.titleMin)
    out.push({ field: 'title', code: 'TITLE_TOO_SHORT', params: { min: R.titleMin } });
  else if (title.length > R.titleMax)
    out.push({ field: 'title', code: 'TITLE_TOO_LONG', params: { max: R.titleMax } });

  if ((input.description ?? '').length > R.descriptionMax)
    out.push({ field: 'description', code: 'DESCRIPTION_TOO_LONG', params: { max: R.descriptionMax } });

  const raw = input.startsAt;
  if (!raw) out.push({ field: 'startsAt', code: 'STARTS_AT_REQUIRED' });
  else {
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) out.push({ field: 'startsAt', code: 'STARTS_AT_INVALID' });
    else if (t < now - R.pastGraceMin * 60_000) out.push({ field: 'startsAt', code: 'STARTS_AT_PAST' });
  }

  const d = input.durationMin;
  if (d === null || d === undefined || d === '' || !isWholeNumber(d))
    out.push({ field: 'durationMin', code: 'DURATION_INVALID' });
  else {
    const n = Number(d);
    if (n < R.durationMin)
      out.push({ field: 'durationMin', code: 'DURATION_TOO_SHORT', params: { min: R.durationMin } });
    else if (n > R.durationMax)
      out.push({ field: 'durationMin', code: 'DURATION_TOO_LONG', params: { max: R.durationMax } });
  }

  const c = input.capacity;
  if (c !== null && c !== undefined && c !== '') {
    if (!isWholeNumber(c)) out.push({ field: 'capacity', code: 'CAPACITY_INVALID' });
    else {
      const n = Number(c);
      if (n < R.capacityMin)
        out.push({ field: 'capacity', code: 'CAPACITY_TOO_SMALL', params: { min: R.capacityMin } });
      else if (n > R.capacityMax)
        out.push({ field: 'capacity', code: 'CAPACITY_TOO_LARGE', params: { max: R.capacityMax } });
    }
  }
  return out;
}
