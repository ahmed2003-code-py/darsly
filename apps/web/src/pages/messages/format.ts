/**
 * Dates, times and sizes for the messenger — in the reader's own timezone and
 * language, and grouped so a long conversation reads as days and turns rather
 * than one wall of timestamps.
 */

/** Messages closer together than this, from the same person, read as one turn. */
export const RUN_GAP_MS = 5 * 60 * 1000;

const locale = (lang: string) => (lang === 'ar' ? 'ar-EG' : 'en-GB');

/** Local calendar day, so "today" means the reader's today. */
export function dayKey(iso: string | Date): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export type DayLabel = { kind: 'today' | 'yesterday' } | { kind: 'date'; text: string };

/** Today / Yesterday / a weekday within the last week / a date. */
export function dayLabel(day: string, lang: string, now = new Date()): DayLabel {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  if (day === today) return { kind: 'today' };
  if (day === yesterday) return { kind: 'yesterday' };
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (ageDays < 7) {
    return { kind: 'date', text: date.toLocaleDateString(locale(lang), { weekday: 'long' }) };
  }
  return {
    kind: 'date',
    text: date.toLocaleDateString(locale(lang), {
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    }),
  };
}

export function timeLabel(iso: string, lang: string): string {
  return new Date(iso).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' });
}

export function fullDateTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleString(locale(lang), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A list time: the clock for today, "yesterday"-style labels, or a short date. */
export function listTime(iso: string, lang: string, now = new Date()): string {
  const day = dayKey(iso);
  if (day === dayKey(now)) return timeLabel(iso, lang);
  const l = dayLabel(day, lang, now);
  if (l.kind === 'yesterday') return lang === 'ar' ? 'أمس' : 'Yesterday';
  if (l.kind === 'date' && now.getTime() - new Date(iso).getTime() < 7 * 86_400_000) return l.text;
  return new Date(iso).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short' });
}

export function formatBytes(n: number, lang: string): string {
  const units = lang === 'ar' ? ['بايت', 'ك.ب', 'م.ب'] : ['B', 'KB', 'MB'];
  if (n < 1024) return `${n} ${units[0]}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${units[1]}`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} ${units[2]}`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where a message sits in its turn: first shows who, last shows when. */
export interface RunPosition {
  first: boolean;
  last: boolean;
}

/** Turn boundaries for an ordered list of messages. */
export function runPositions(messages: { senderId: string; createdAt: string }[]): RunPosition[] {
  const sameRun = (a: (typeof messages)[number], b: (typeof messages)[number]) =>
    a.senderId === b.senderId &&
    dayKey(a.createdAt) === dayKey(b.createdAt) &&
    Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) <= RUN_GAP_MS;
  return messages.map((m, i) => ({
    first: i === 0 || !sameRun(messages[i - 1], m),
    last: i === messages.length - 1 || !sameRun(m, messages[i + 1]),
  }));
}
