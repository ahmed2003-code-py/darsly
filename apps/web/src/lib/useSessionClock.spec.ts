import { formatClock, nextAnchor, readClock } from './useSessionClock';

/**
 * The classroom clock trusts the server's times, not the device's, and never
 * lets an older answer undo a newer one (a slow heartbeat reply arriving after
 * an extension).
 */
const T = Date.UTC(2026, 8, 25, 18, 0, 0);
const MIN = 60_000;
const timing = (serverNow: number, endsAt: number, startedAt: number | null = T - 10 * MIN) => ({
  serverNow: new Date(serverNow).toISOString(),
  endsAt: new Date(endsAt).toISOString(),
  startedAt: startedAt == null ? null : new Date(startedAt).toISOString(),
});

describe('the session clock', () => {
  it('counts in server time on a device whose clock is two minutes fast', () => {
    const device = T + 2 * MIN;
    const a = nextAnchor(null, timing(T, T + 50 * MIN), device)!;
    // Thirty seconds later, by the device's own (wrong) clock.
    const c = readClock(a, device + 30_000);
    expect(c.elapsedMs).toBe(10 * MIN + 30_000);
    expect(c.remainingMs).toBe(50 * MIN - 30_000);
  });

  it('an extension moves the end; a slower, older reply cannot move it back', () => {
    let a = nextAnchor(null, timing(T, T + 50 * MIN), T);
    a = nextAnchor(a, timing(T + 5_000, T + 65 * MIN), T + 5_000); // extended +15
    a = nextAnchor(a, timing(T + 4_000, T + 50 * MIN), T + 6_000); // late heartbeat reply
    expect(a!.endsAt).toBe(T + 65 * MIN);
  });

  it('before the teacher opens the room there is no elapsed time to show', () => {
    const a = nextAnchor(null, timing(T, T + 60 * MIN, null), T)!;
    expect(readClock(a, T).elapsedMs).toBeNull();
  });

  it('past the end, remaining goes negative (the page shows overtime)', () => {
    const a = nextAnchor(null, timing(T, T + MIN), T)!;
    expect(readClock(a, T + 2 * MIN).remainingMs).toBe(-MIN);
  });

  it('ignores an answer without the times it needs', () => {
    expect(nextAnchor(null, { serverNow: '', endsAt: '', startedAt: null } as any, T)).toBeNull();
    expect(nextAnchor(null, undefined, T)).toBeNull();
  });

  it('formats as mm:ss, and h:mm:ss past an hour', () => {
    expect(formatClock(5 * MIN + 9_000)).toBe('05:09');
    expect(formatClock(65 * MIN + 9_000)).toBe('1:05:09');
    expect(formatClock(-5_000)).toBe('00:00');
  });
});
