import { ChallengeScoringService } from './challenge-scoring.service';

describe('ChallengeScoringService', () => {
  const svc = new ChallengeScoringService();

  describe('scoreAnswer', () => {
    it('a wrong answer is always worth 0, regardless of speed or scoring mode', () => {
      const r = svc.scoreAnswer({
        isCorrect: false,
        onTime: true,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs: 1,
        allowedTimeSec: 20,
      });
      expect(r.xpAwarded).toBe(0);
    });

    it('a late answer is always worth 0, even if it was correct', () => {
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: false,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs: 999_999,
        allowedTimeSec: 20,
      });
      expect(r.xpAwarded).toBe(0);
    });

    it('STANDARD scoring pays flat base points on a correct, on-time answer — no speed bonus', () => {
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 100,
        scoring: 'STANDARD',
        timeTakenMs: 500, // answered almost instantly
        allowedTimeSec: 20,
      });
      expect(r.xpAwarded).toBe(100);
      expect(r.speedBonusPct).toBe(0);
    });

    it('SPEED_BASED with no timer on the question falls back to flat base points', () => {
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs: 12_345,
        allowedTimeSec: null,
      });
      expect(r.xpAwarded).toBe(100);
    });

    // The five tiers from the product brief: 0-20% => +100%, 20-40% => +75%,
    // 40-60% => +50%, 60-80% => +25%, 80-100% => +10%.
    const cases: [usedPct: number, expectedBonusPct: number][] = [
      [0, 100],
      [10, 100],
      [20, 100], // boundary — inclusive of the faster tier
      [20.01, 75],
      [39, 75],
      [40, 75],
      [40.01, 50],
      [59, 50],
      [60, 50],
      [60.01, 25],
      [79, 25],
      [80, 25],
      [80.01, 10],
      [99, 10],
      [100, 10],
    ];
    it.each(cases)('at %s%% of allowed time used, the speed bonus is +%s%%', (usedPct, expectedBonusPct) => {
      const allowedTimeSec = 20;
      const timeTakenMs = (usedPct / 100) * allowedTimeSec * 1000;
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs,
        allowedTimeSec,
      });
      expect(r.speedBonusPct).toBe(expectedBonusPct);
      expect(r.xpAwarded).toBe(100 + Math.round((100 * expectedBonusPct) / 100));
    });

    it('zero elapsed time (answered the instant the question appeared) is the fastest tier, not a divide-by-zero', () => {
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs: 0,
        allowedTimeSec: 20,
      });
      expect(r.xpAwarded).toBe(200); // 100 base + 100% bonus
      expect(r.usedFraction).toBe(0);
    });

    it('time taken beyond the allowed window is clamped to the slowest tier, not extrapolated below it', () => {
      // onTime is computed separately (isOnTime) — this exercises scoreAnswer's
      // own defensive clamp for a caller that somehow passes onTime: true anyway.
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 100,
        scoring: 'SPEED_BASED',
        timeTakenMs: 999_999,
        allowedTimeSec: 20,
      });
      expect(r.usedFraction).toBe(1);
      expect(r.speedBonusPct).toBe(10);
    });

    it('a zero base-point question never pays a negative or NaN amount', () => {
      const r = svc.scoreAnswer({
        isCorrect: true,
        onTime: true,
        basePoints: 0,
        scoring: 'SPEED_BASED',
        timeTakenMs: 0,
        allowedTimeSec: 20,
      });
      expect(r.xpAwarded).toBe(0);
      expect(Number.isNaN(r.xpAwarded)).toBe(false);
    });
  });

  describe('isOnTime', () => {
    it('no per-question timer means nothing is ever late', () => {
      expect(svc.isOnTime(999_999_999, null)).toBe(true);
    });

    it('within the allowed window is on time', () => {
      expect(svc.isOnTime(19_000, 20)).toBe(true);
    });

    it('past the allowed window plus grace is late', () => {
      expect(svc.isOnTime(20_000 + ChallengeScoringService.GRACE_MS + 1, 20)).toBe(false);
    });

    it('within the grace period past the nominal deadline still counts as on time', () => {
      expect(svc.isOnTime(20_000 + ChallengeScoringService.GRACE_MS - 1, 20)).toBe(true);
    });
  });

  describe('summarize', () => {
    it('an attempt with no answered questions summarizes to a clean zero, not NaN', () => {
      const r = svc.summarize([]);
      expect(r).toEqual({ score: 0, correctCount: 0, wrongCount: 0, accuracyPct: 0, speedPct: null });
    });

    it('sums xp, counts correct/wrong, and averages speed only across timed answers', () => {
      const r = svc.summarize([
        { isCorrect: true, xpAwarded: 200, usedFraction: 0 }, // fastest possible
        { isCorrect: true, xpAwarded: 110, usedFraction: 0.9 }, // slow
        { isCorrect: false, xpAwarded: 0, usedFraction: null }, // wrong, no timer question
      ]);
      expect(r.score).toBe(310);
      expect(r.correctCount).toBe(2);
      expect(r.wrongCount).toBe(1);
      expect(r.accuracyPct).toBe(67); // 2/3 rounded
      // speed averages only the two timed answers: (1 - avg(0, 0.9)) * 100 = 55
      expect(r.speedPct).toBe(55);
    });

    it('accuracy and speed are 100 when every answer was instant and correct', () => {
      const r = svc.summarize([
        { isCorrect: true, xpAwarded: 200, usedFraction: 0 },
        { isCorrect: true, xpAwarded: 200, usedFraction: 0 },
      ]);
      expect(r.accuracyPct).toBe(100);
      expect(r.speedPct).toBe(100);
    });
  });
});
