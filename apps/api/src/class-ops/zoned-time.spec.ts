import {
  addDays,
  isValidTimeZone,
  localDayBounds,
  parseClock,
  formatClock,
  wallClock,
  weekdayOf,
  zonedToInstant,
} from './zoned-time';

const CAIRO = 'Africa/Cairo';
const iso = (d: Date) => d.toISOString();

describe('zoned time (C2 timetable clock)', () => {
  it('18:00 Cairo is 16:00Z in winter (UTC+2) and 15:00Z in summer (UTC+3)', () => {
    expect(iso(zonedToInstant('2026-04-23', 18 * 60, CAIRO))).toBe('2026-04-23T16:00:00.000Z');
    expect(iso(zonedToInstant('2026-04-25', 18 * 60, CAIRO))).toBe('2026-04-25T15:00:00.000Z');
    expect(iso(zonedToInstant('2026-10-31', 18 * 60, CAIRO))).toBe('2026-10-31T16:00:00.000Z');
  });

  it('the same weekly slot keeps its local time across the spring change', () => {
    // Thursday before and after Egypt's 2026 change (night of 23→24 April).
    for (const date of ['2026-04-16', '2026-04-23', '2026-04-30', '2026-05-07']) {
      const at = zonedToInstant(date, 18 * 60, CAIRO);
      expect(wallClock(at, CAIRO)).toEqual({ date, minute: 18 * 60, weekday: 4 });
    }
  });

  it('a time inside the spring-forward gap moves forward by the gap', () => {
    // 00:30 on 24 April 2026 never exists in Cairo (00:00 → 01:00).
    const at = zonedToInstant('2026-04-24', 30, CAIRO);
    expect(wallClock(at, CAIRO)).toEqual({ date: '2026-04-24', minute: 90, weekday: 5 });
  });

  it('a repeated time at fall-back resolves to its first occurrence', () => {
    // 23:30 on 29 October 2026 happens twice (24:00 → 23:00): 20:30Z then 21:30Z.
    expect(iso(zonedToInstant('2026-10-29', 23 * 60 + 30, CAIRO))).toBe('2026-10-29T20:30:00.000Z');
  });

  it('works for other zones: New York DST and a half-hour offset', () => {
    expect(iso(zonedToInstant('2026-03-07', 18 * 60, 'America/New_York'))).toBe(
      '2026-03-07T23:00:00.000Z',
    );
    expect(iso(zonedToInstant('2026-03-09', 18 * 60, 'America/New_York'))).toBe(
      '2026-03-09T22:00:00.000Z',
    );
    expect(iso(zonedToInstant('2026-06-01', 9 * 60, 'Asia/Kolkata'))).toBe(
      '2026-06-01T03:30:00.000Z',
    );
  });

  it('local day bounds are 23 or 25 hours long on change days', () => {
    const spring = localDayBounds('2026-04-24', CAIRO);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = localDayBounds('2026-10-29', CAIRO);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
    const normal = localDayBounds('2026-05-10', CAIRO);
    expect(iso(normal.start)).toBe('2026-05-09T21:00:00.000Z');
  });

  it('wallClock reads the local date, not the server date', () => {
    // 22:30Z on the 1st is already the 2nd in Cairo.
    expect(wallClock(new Date('2026-06-01T22:30:00Z'), CAIRO).date).toBe('2026-06-02');
  });

  it('calendar helpers', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-03')).toBe(6); // a Saturday
    expect(parseClock('18:00')).toBe(1080);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7:00')).toBeNull();
    expect(formatClock(1080)).toBe('18:00');
    expect(isValidTimeZone(CAIRO)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
