/**
 * Wall-clock ↔ instant conversion for an IANA timezone, without a date
 * library (the same approach as gamification/period.util.ts, generalised
 * from Cairo to any academy's zone).
 *
 * A weekly slot says "Saturday 18:00" in the academy's clock. Each occurrence
 * is converted on its OWN date, so when the zone changes its offset (Egypt
 * observes summer time again since 2023) the class stays at 18:00 local and
 * its UTC instant moves — never the other way round.
 *
 * Local dates are 'YYYY-MM-DD' strings throughout; they never pass through a
 * Date in the server's zone, which is how "the previous day" bugs happen.
 */

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatter.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatter.set(timeZone, f);
  }
  return f;
}

/** Is this a zone the runtime knows? (Used to validate stored settings.) */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface WallClock {
  /** 'YYYY-MM-DD' in the zone. */
  date: string;
  /** Minutes after local midnight. */
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

/** What a clock on the wall in `timeZone` shows at instant `at`. */
export function wallClock(at: Date, timeZone: string): WallClock {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
  };
}

/** The zone's offset from UTC at instant `at`, in minutes (Cairo summer: +180). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` +
 * `minute`. Around a transition the two offsets in force a day either side
 * give the candidates:
 *  - a repeated time (fall-back overlap) reads back from both — the EARLIER
 *    instant is chosen, the first time the clock shows it;
 *  - a time that never exists (spring-forward gap) reads back from neither —
 *    it is shifted forward by the gap (Cairo 00:30 on the change night →
 *    01:30), the way calendars treat it, never silently an hour early.
 */
export function zonedToInstant(date: string, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const before = offsetMinutes(new Date(naive - 86_400_000), timeZone);
  const after = offsetMinutes(new Date(naive + 86_400_000), timeZone);
  const candidates = [...new Set([naive - before * 60_000, naive - after * 60_000])];
  const reads = (t: number) => {
    const w = wallClock(new Date(t), timeZone);
    return w.date === date && w.minute === minute;
  };
  const valid = candidates.filter(reads);
  if (valid.length) return new Date(Math.min(...valid));
  // The gap: the offset before the jump is the smaller one, so this is the
  // later instant — the requested reading pushed forward past the jump.
  return new Date(naive - Math.min(before, after) * 60_000);
}

/** 'YYYY-MM-DD' shifted by whole days (pure calendar arithmetic, UTC-based). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** A @db.Date column value as 'YYYY-MM-DD' (Prisma returns midnight UTC). */
export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' as the Date Prisma writes into a @db.Date column. */
export function dateValue(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The local calendar day [start, end) in `timeZone` as instants. */
export function localDayBounds(date: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedToInstant(date, 0, timeZone),
    end: zonedToInstant(addDays(date, 1), 0, timeZone),
  };
}

/** 'HH:MM' → minutes, or null when malformed. */
export function parseClock(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** minutes → 'HH:MM'. */
export function formatClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
