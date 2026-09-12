/**
 * Time, as a student in Egypt experiences it.
 *
 * Every period boundary in this module — a mission day, a leaderboard week, an
 * "early bird" session — is computed in Africa/Cairo rather than in the
 * server's timezone. Railway runs in UTC, and a student studying at 1am in
 * Cairo is at 11pm UTC the day before: with server time, their day would end
 * two hours early and their streak day would land on yesterday. The people
 * using this product all live in one timezone; the code should say so.
 */

const TZ = 'Africa/Cairo';

/**
 * Cairo's UTC offset at a given instant, in minutes.
 *
 * Egypt reintroduced summer time in 2023, so the offset is +2 in winter and +3
 * in summer. Hard-coding +02:00 — as an earlier draft of this file did — puts
 * every "midnight" an hour late for half the year, which silently drops the
 * first hour of each day out of daily caps and mission backfills.
 */
function cairoOffsetMinutes(at: Date): number {
  const asCairo = new Date(at.toLocaleString('en-US', { timeZone: TZ }));
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((asCairo.getTime() - asUtc.getTime()) / 60_000);
}

/** The UTC instant at which the given Cairo day (a dayKey) begins. */
export function startOfCairoDay(key: string = dayKey()): Date {
  const guess = new Date(`${key}T00:00:00Z`);
  const offset = cairoOffsetMinutes(guess);
  const candidate = new Date(guess.getTime() - offset * 60_000);
  // If the guess landed on the far side of a clock change, the offset at the
  // candidate is the one that actually applies.
  const settled = cairoOffsetMinutes(candidate);
  return settled === offset ? candidate : new Date(guess.getTime() - settled * 60_000);
}

/** The wall-clock parts in Cairo for a given instant. */
function cairoParts(at: Date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    weekday: parts.weekday as string, // 'Sat' … 'Fri'
  };
}

/** '2026-09-12' — the key a daily mission lives under. */
export function dayKey(at: Date = new Date()): string {
  const p = cairoParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** '2026-09' — the monthly leaderboard bucket. */
export function monthKey(at: Date = new Date()): string {
  const p = cairoParts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/**
 * '2026-W37' — the weekly bucket, weeks starting Saturday.
 *
 * Saturday, because that is when the Egyptian school week starts; a leaderboard
 * that resets on Monday morning would cut the week in half for every student
 * using it.
 */
export function weekKey(at: Date = new Date()): string {
  const start = startOfCairoWeek(at);
  const p = cairoParts(new Date(start.getTime() + 3_600_000)); // safely inside the day
  // Week number counted from the first Saturday-week of the year, which is all
  // this needs to be: a stable, sortable bucket id, not an ISO-8601 week.
  const jan1 = new Date(Date.UTC(p.year, 0, 1));
  const week = Math.floor((start.getTime() - jan1.getTime()) / (7 * 86_400_000)) + 1;
  return `${p.year}-W${String(week).padStart(2, '0')}`;
}

const WEEKDAY_INDEX: Record<string, number> = { Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6 };

/** Midnight Cairo on the Saturday that opens this week, as a UTC instant. */
export function startOfCairoWeek(at: Date = new Date()): Date {
  const p = cairoParts(at);
  const since = WEEKDAY_INDEX[p.weekday] ?? 0;
  const midnight = startOfCairoDay(dayKey(at));
  // Subtracting whole days can drift by an hour across a clock change, so the
  // result is re-normalised through the day it lands in.
  return startOfCairoDay(dayKey(new Date(midnight.getTime() - since * 86_400_000 + 3_600_000)));
}

/** Hour of day (0–23) in Cairo — for the early-bird / night-owl achievements. */
export function cairoHour(at: Date = new Date()): number {
  return cairoParts(at).hour;
}

/** Friday or Saturday: the Egyptian weekend. */
export function isCairoWeekend(at: Date = new Date()): boolean {
  const d = cairoParts(at).weekday;
  return d === 'Fri' || d === 'Sat';
}
