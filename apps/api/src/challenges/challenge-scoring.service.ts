import { Injectable } from '@nestjs/common';

/**
 * The one place a Challenge answer's XP is computed.
 *
 * Deliberately a pure, stateless, config-driven service rather than logic
 * spread across the controller/service/frontend: every rule that decides how
 * many points an answer is worth lives here, once, so a request can never
 * carry a score and a teacher can never see two different formulas in two
 * different screens. The frontend never scores anything — it only renders
 * what this service already decided.
 *
 * A wrong answer, and any answer that arrives after its allowed time, are
 * always worth zero. Nothing above bypasses that: `scoreAnswer` never runs
 * the speed math unless the caller has already established the answer was
 * both correct and on time.
 */
@Injectable()
export class ChallengeScoringService {
  /**
   * Speed bonus tiers, by fraction of the allowed time used.
   *
   * `upToFraction` is inclusive: an answer using exactly 20% of its time
   * budget gets the fastest tier's bonus, not the next one down. Tuned here
   * and nowhere else — see the class doc.
   */
  static readonly SPEED_TIERS: ReadonlyArray<{ upToFraction: number; bonusPct: number }> = [
    { upToFraction: 0.2, bonusPct: 100 },
    { upToFraction: 0.4, bonusPct: 75 },
    { upToFraction: 0.6, bonusPct: 50 },
    { upToFraction: 0.8, bonusPct: 25 },
    { upToFraction: 1.0, bonusPct: 10 },
  ];

  /**
   * XP for one answer.
   *
   * `allowedTimeSec` is the question's own timer if it has one — the whole
   * point of asking for it explicitly rather than reading a shared default is
   * that a caller who has no timer at all (an untimed challenge) has no basis
   * to reward speed, and passes `null` to say so honestly instead of a made-up
   * number.
   */
  scoreAnswer(input: {
    isCorrect: boolean;
    onTime: boolean;
    basePoints: number;
    scoring: 'STANDARD' | 'SPEED_BASED';
    timeTakenMs: number;
    allowedTimeSec: number | null;
  }): { xpAwarded: number; speedBonusPct: number; usedFraction: number | null } {
    if (!input.isCorrect || !input.onTime) {
      return { xpAwarded: 0, speedBonusPct: 0, usedFraction: null };
    }
    if (input.scoring !== 'SPEED_BASED' || !input.allowedTimeSec || input.allowedTimeSec <= 0) {
      return { xpAwarded: Math.max(0, input.basePoints), speedBonusPct: 0, usedFraction: null };
    }

    const usedFraction = Math.min(
      1,
      Math.max(0, input.timeTakenMs / (input.allowedTimeSec * 1000)),
    );
    const tier =
      ChallengeScoringService.SPEED_TIERS.find((t) => usedFraction <= t.upToFraction) ??
      ChallengeScoringService.SPEED_TIERS[ChallengeScoringService.SPEED_TIERS.length - 1];

    const bonus = Math.round((input.basePoints * tier.bonusPct) / 100);
    return { xpAwarded: input.basePoints + bonus, speedBonusPct: tier.bonusPct, usedFraction };
  }

  /**
   * Whether an answer arrived within its allowed time.
   *
   * The grace mirrors QuizzesService's own: the deadline is for the student,
   * not the network — a correct answer sent right at the buzzer still has to
   * cross the wire, and losing it to that would be the platform's fault, not
   * theirs. `allowedTimeSec == null` means there was never a per-question
   * timer to miss.
   */
  static readonly GRACE_MS = 2_000;

  isOnTime(timeTakenMs: number, allowedTimeSec: number | null): boolean {
    if (allowedTimeSec == null) return true;
    return timeTakenMs <= allowedTimeSec * 1000 + ChallengeScoringService.GRACE_MS;
  }

  /** Roll up a finished attempt's per-answer results into its final stats. */
  summarize(
    answers: { isCorrect: boolean; xpAwarded: number; usedFraction: number | null }[],
  ): {
    score: number;
    correctCount: number;
    wrongCount: number;
    accuracyPct: number;
    speedPct: number | null;
  } {
    const correctCount = answers.filter((a) => a.isCorrect).length;
    const wrongCount = answers.length - correctCount;
    const score = answers.reduce((sum, a) => sum + a.xpAwarded, 0);
    const accuracyPct = answers.length ? Math.round((correctCount / answers.length) * 100) : 0;

    const timed = answers.filter((a): a is typeof a & { usedFraction: number } => a.usedFraction != null);
    const speedPct = timed.length
      ? Math.round((1 - timed.reduce((sum, a) => sum + a.usedFraction, 0) / timed.length) * 100)
      : null;

    return { score, correctCount, wrongCount, accuracyPct, speedPct };
  }
}
