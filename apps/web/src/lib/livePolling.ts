/**
 * How often to ask again while a live seat's state can change by itself —
 * a transfer being matched, a teacher opening the room.
 *
 * Quick at first (an SMS usually lands within a minute of the transfer),
 * then gentler, then stop: a page left open overnight must not poll for ever.
 * Returned as react-query's `refetchInterval` value.
 */
export function backoffInterval(sinceMs: number, now = Date.now()): number | false {
  const age = now - sinceMs;
  if (age < 2 * 60_000) return 3_000;
  if (age < 10 * 60_000) return 6_000;
  if (age < 60 * 60_000) return 15_000;
  if (age < 4 * 3600_000) return 45_000;
  return false;
}

/** Whole minutes/seconds until a moment, for a countdown ("2:05:09", "4:07"). */
export function countdown(untilMs: number, now = Date.now()): string | null {
  const left = untilMs - now;
  if (left <= 0) return null;
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
