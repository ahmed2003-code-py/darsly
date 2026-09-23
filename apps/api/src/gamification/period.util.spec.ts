import {
  cairoHour,
  dayKey,
  isCairoWeekend,
  monthKey,
  startOfCairoDay,
  startOfCairoWeek,
  weekKey,
} from './period.util';

/**
 * These boundaries decide when a mission expires and when a leaderboard week
 * resets, so they are tested against instants that are deliberately awkward:
 * late-night UTC (which is already tomorrow in Cairo) and the Friday/Saturday
 * weekend that Egypt keeps and most date libraries do not.
 */
describe('period keys (Africa/Cairo)', () => {
  it('rolls the day at Cairo midnight in winter (UTC+2)', () => {
    expect(dayKey(new Date('2026-01-11T22:30:00Z'))).toBe('2026-01-12'); // 00:30 there
    expect(dayKey(new Date('2026-01-11T21:00:00Z'))).toBe('2026-01-11'); // 23:00 there
  });

  it('rolls the day at Cairo midnight in summer too, when the offset is +3', () => {
    // Egypt keeps summer time again since 2023, and an hour of every day went
    // missing from daily caps while this assumed a fixed +02:00.
    expect(dayKey(new Date('2026-09-11T21:30:00Z'))).toBe('2026-09-12'); // 00:30 there
    expect(dayKey(new Date('2026-09-11T20:00:00Z'))).toBe('2026-09-11'); // 23:00 there
  });

  it('places the start of a Cairo day at the right instant in both offsets', () => {
    expect(startOfCairoDay('2026-01-12').toISOString()).toBe('2026-01-11T22:00:00.000Z');
    expect(startOfCairoDay('2026-09-12').toISOString()).toBe('2026-09-11T21:00:00.000Z');
  });

  it('reports the Cairo hour, which is what "early bird" means', () => {
    expect(cairoHour(new Date('2026-09-11T21:30:00Z'))).toBe(0); // 00:30 Cairo
    expect(cairoHour(new Date('2026-09-12T04:00:00Z'))).toBe(7); // 07:00 Cairo
  });

  it('treats Friday and Saturday as the weekend', () => {
    expect(isCairoWeekend(new Date('2026-09-11T09:00:00Z'))).toBe(true); // Friday
    expect(isCairoWeekend(new Date('2026-09-12T09:00:00Z'))).toBe(true); // Saturday
    expect(isCairoWeekend(new Date('2026-09-13T09:00:00Z'))).toBe(false); // Sunday
  });

  it('starts the week on Saturday, so a school week is never split', () => {
    const sat = startOfCairoWeek(new Date('2026-09-12T10:00:00Z')); // Saturday
    const tue = startOfCairoWeek(new Date('2026-09-15T10:00:00Z')); // Tuesday after
    expect(tue.getTime()).toBe(sat.getTime());

    // The Friday before belongs to the previous week.
    const fri = startOfCairoWeek(new Date('2026-09-11T10:00:00Z'));
    expect(fri.getTime()).toBeLessThan(sat.getTime());
  });

  it('gives every day of one week the same key, and the next week a new one', () => {
    const sat = weekKey(new Date('2026-09-12T10:00:00Z'));
    const thu = weekKey(new Date('2026-09-17T10:00:00Z'));
    const nextSat = weekKey(new Date('2026-09-19T10:00:00Z'));
    expect(thu).toBe(sat);
    expect(nextSat).not.toBe(sat);
  });

  it('buckets months in Cairo terms', () => {
    expect(monthKey(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10'); // already October there
    expect(monthKey(new Date('2026-09-30T12:00:00Z'))).toBe('2026-09');
  });
});
