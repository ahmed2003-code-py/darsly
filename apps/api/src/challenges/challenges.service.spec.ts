import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChallengesService } from './challenges.service';
import { ChallengeScoringService } from './challenge-scoring.service';

const CHALLENGE = {
  id: 'ch1',
  tenantId: 't1',
  courseId: null,
  type: 'PRACTICE',
  status: 'PUBLISHED',
  durationSec: null,
  questionTimeSec: 20,
  scoring: 'SPEED_BASED',
  maxAttempts: 1,
  answerReveal: 'AFTER_SUBMISSION',
  leaderboardEnabled: true,
  randomize: 'NONE',
};

const QUESTIONS = [
  { id: 'q1', challengeId: 'ch1', type: 'MCQ', prompt: 'a', imageUrl: null, options: [{ id: 'o1', text: 'x' }, { id: 'o2', text: 'y' }], correctOptionIds: ['o1'], explanation: 'because', points: 100, timeLimitSec: null, topic: null, sortOrder: 0 },
  { id: 'q2', challengeId: 'ch1', type: 'MCQ', prompt: 'b', imageUrl: null, options: [{ id: 'o1', text: 'x' }, { id: 'o2', text: 'y' }], correctOptionIds: ['o2'], explanation: 'because2', points: 100, timeLimitSec: null, topic: null, sortOrder: 1 },
];

function makeCtx(opts: { challenge?: Partial<typeof CHALLENGE> } = {}) {
  const challenge = { ...CHALLENGE, ...opts.challenge };
  const attempts = new Map<string, any>();
  const answers = new Map<string, any>(); // key: attemptId:questionId

  const prisma: any = {
    challenge: {
      findUnique: jest.fn().mockResolvedValue(challenge),
      findUniqueOrThrow: jest.fn().mockResolvedValue(challenge),
      create: jest.fn((args: any) => Promise.resolve({ id: 'newch', ...args.data })),
    },
    challengeQuestion: {
      findMany: jest.fn().mockResolvedValue(QUESTIONS),
      findFirst: jest.fn((args: any) => Promise.resolve(QUESTIONS.find((q) => q.id === args.where.id) ?? null)),
      findUnique: jest.fn((args: any) => Promise.resolve(QUESTIONS.find((q) => q.id === args.where.id) ?? null)),
    },
    challengeAttempt: {
      findMany: jest.fn((args: any) =>
        Promise.resolve([...attempts.values()].filter((a) => a.studentId === args.where.studentId && a.challengeId === args.where.challengeId)),
      ),
      findFirst: jest.fn((args: any) => {
        const a = attempts.get(args.where.id);
        if (!a) return Promise.resolve(null);
        if (args.where.studentId && a.studentId !== args.where.studentId) return Promise.resolve(null);
        if (args.where.challengeId && a.challengeId !== args.where.challengeId) return Promise.resolve(null);
        return Promise.resolve(a);
      }),
      create: jest.fn((args: any) => {
        const row = { id: `att${attempts.size + 1}`, status: 'IN_PROGRESS', startedAt: new Date(), deadlineAt: null, score: 0, correctCount: 0, wrongCount: 0, accuracyPct: null, speedPct: null, xpAwarded: 0, coinsAwarded: 0, ...args.data };
        attempts.set(row.id, row);
        return Promise.resolve(row);
      }),
      update: jest.fn((args: any) => {
        const row = { ...attempts.get(args.where.id), ...args.data };
        attempts.set(args.where.id, row);
        return Promise.resolve(row);
      }),
      count: jest.fn().mockResolvedValue(0),
    },
    challengeAnswer: {
      count: jest.fn((args: any) => Promise.resolve([...answers.values()].filter((a) => a.attemptId === args.where.attemptId).length)),
      findMany: jest.fn((args: any) => {
        const attemptId = args.where.attemptId;
        const isCorrectFilter = args.where.isCorrect;
        let rows = [...answers.values()].filter((a) => a.attemptId === attemptId);
        if (isCorrectFilter !== undefined) rows = rows.filter((a) => a.isCorrect === isCorrectFilter);
        if (args.include?.question) {
          rows = rows.map((r) => ({ ...r, question: QUESTIONS.find((q) => q.id === r.questionId) }));
        }
        return Promise.resolve(rows);
      }),
      findUnique: jest.fn((args: any) => Promise.resolve(answers.get(`${args.where.attemptId_questionId.attemptId}:${args.where.attemptId_questionId.questionId}`) ?? null)),
      create: jest.fn((args: any) => {
        const key = `${args.data.attemptId}:${args.data.questionId}`;
        if (answers.has(key)) {
          const err: any = new Error('duplicate');
          err.code = 'P2002';
          err.constructor = { name: 'PrismaClientKnownRequestError' };
          Object.setPrototypeOf(err, require('@prisma/client').Prisma.PrismaClientKnownRequestError.prototype);
          throw err;
        }
        const row = { id: key, answeredAt: new Date(), ...args.data };
        answers.set(key, row);
        return Promise.resolve(row);
      }),
      createMany: jest.fn((args: any) => {
        for (const d of args.data) {
          const key = `${d.attemptId}:${d.questionId}`;
          if (!answers.has(key)) answers.set(key, { id: key, answeredAt: new Date(), ...d });
        }
        return Promise.resolve({ count: args.data.length });
      }),
    },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  };

  const access: any = {
    studentIdOf: jest.fn().mockResolvedValue('s1'),
    requireStudentAccess: jest.fn().mockResolvedValue({ challenge, studentId: 's1' }),
    requireTeacherChallenge: jest.fn().mockResolvedValue(challenge),
  };
  const gamification: any = {
    record: jest.fn().mockResolvedValue({ awarded: true, xp: 100, coins: 20, totalXp: 500, level: 2, leveledUp: false, achievements: [], missions: [] }),
    checkStreakMilestone: jest.fn().mockResolvedValue({ awarded: false }),
  };
  const progress: any = { touchActivity: jest.fn().mockResolvedValue({ rolled: false, currentStreak: 1, freezeUsed: false }) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const scoring = new ChallengeScoringService();

  const svc = new ChallengesService(prisma, access, scoring, gamification, progress, notifications);
  return { svc, prisma, access, gamification, progress, notifications, attempts, answers, challenge };
}

describe('ChallengesService — type-aware creation defaults', () => {
  it('a RANKED challenge with no settings given gets competitive defaults', async () => {
    const { svc } = makeCtx();
    const c = await svc.create('t1', { title: 'r', type: 'RANKED' } as any);
    expect(c.scoring).toBe('SPEED_BASED');
    expect(c.questionTimeSec).toBe(20);
    expect(c.maxAttempts).toBe(1);
    expect(c.leaderboardEnabled).toBe(true);
    expect(c.answerReveal).toBe('AFTER_SUBMISSION');
  });

  it('a PRACTICE challenge with no settings given gets low-pressure defaults', async () => {
    const { svc } = makeCtx();
    const c = await svc.create('t1', { title: 'p', type: 'PRACTICE' } as any);
    expect(c.scoring).toBe('STANDARD');
    expect(c.questionTimeSec).toBeNull();
    expect(c.maxAttempts).toBe(3);
    expect(c.leaderboardEnabled).toBe(false);
    expect(c.answerReveal).toBe('IMMEDIATE');
  });

  it('an explicitly-set field always wins over the type default', async () => {
    const { svc } = makeCtx();
    const c = await svc.create('t1', { title: 'r', type: 'RANKED', maxAttempts: 5, leaderboardEnabled: false } as any);
    expect(c.maxAttempts).toBe(5);
    expect(c.leaderboardEnabled).toBe(false);
    expect(c.scoring).toBe('SPEED_BASED'); // untouched fields still default
  });
});

describe('ChallengesService — attempt lifecycle & anti-cheat', () => {
  it('starts a fresh attempt with every question in it, answers stripped of correct-answer data', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    expect(state.totalQuestions).toBe(2);
    expect(state.questions[0]).not.toHaveProperty('correctOptionIds');
    expect(state.questions[0].points).toBe(100); // shown for the live XP ticker — not a security concern
    expect(state.status).toBe('IN_PROGRESS');
  });

  it('resuming start twice in a row returns the SAME open attempt, not a second one', async () => {
    const { svc, attempts } = makeCtx();
    const first = await svc.startAttempt('u1', 'ch1');
    const second = await svc.startAttempt('u1', 'ch1');
    expect(second.attemptId).toBe(first.attemptId);
    expect(attempts.size).toBe(1);
  });

  it('refuses to start once maxAttempts is used up', async () => {
    const { svc, prisma } = makeCtx({ challenge: { maxAttempts: 1 } });
    prisma.challengeAttempt.findMany.mockResolvedValueOnce([{ id: 'old', status: 'COMPLETED', studentId: 's1', challengeId: 'ch1' }]);
    await expect(svc.startAttempt('u1', 'ch1')).rejects.toThrow(BadRequestException);
  });

  it('a wrong answer scores 0 XP and does not advance beyond what it earned', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    const res = await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o2'] });
    expect(res.isCorrect).toBe(false);
    expect(res.xpAwarded).toBe(0);
  });

  it('a correct, fast answer earns the base points plus the full speed bonus', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    const res = await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    expect(res.isCorrect).toBe(true);
    expect(res.xpAwarded).toBe(200); // answered essentially instantly in the test → fastest tier
  });

  it('resubmitting the same question is idempotent — returns the stored result, never rescored', async () => {
    const { svc, answers } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    const first = await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    const sizeAfterFirst = answers.size;
    const second = await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o2'] }); // even a different answer
    expect(second).toEqual(first); // same stored result, the second (different!) submission never applied
    expect(answers.size).toBe(sizeAfterFirst); // no new row written
  });

  it('refuses an answer for a question that is not the current one (no skipping ahead)', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    await expect(svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] }))
      .rejects.toThrow(BadRequestException);
  });

  it('a student can never touch another student\'s attempt', async () => {
    const { svc, attempts } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    attempts.get(state.attemptId).studentId = 's1'; // owner is s1
    // A second student, s2, tries to answer the same attempt id.
    const other = makeCtx();
    other.access.requireStudentAccess.mockResolvedValue({ challenge: other.challenge, studentId: 's2' });
    other.attempts.set(state.attemptId, { ...attempts.get(state.attemptId) }); // simulate shared lookup table
    await expect(
      other.svc.answer('u2', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] }),
    ).rejects.toThrow(NotFoundException);
  });

  it('completing an attempt fills unanswered questions as wrong/zero XP', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    // q2 never answered
    const result = await svc.complete('u1', 'ch1', state.attemptId);
    expect(result.correctCount).toBe(1);
    expect(result.wrongCount).toBe(1);
    expect(result.status).toBe('COMPLETED');
  });

  it('completing an already-completed attempt is a no-op — same result, gamification never awarded twice', async () => {
    const { svc, gamification } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    const first = await svc.complete('u1', 'ch1', state.attemptId);
    const callsAfterFirst = gamification.record.mock.calls.length;
    const second = await svc.complete('u1', 'ch1', state.attemptId);
    expect(second.score).toBe(first.score);
    expect(gamification.record.mock.calls.length).toBe(callsAfterFirst); // not called again
  });

  it('a PRACTICE challenge never fires CHALLENGE_WON, only CHALLENGE_COMPLETED', async () => {
    const { svc, gamification } = makeCtx({ challenge: { type: 'PRACTICE' } });
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    await svc.complete('u1', 'ch1', state.attemptId);
    const types = gamification.record.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toContain('CHALLENGE_COMPLETED');
    expect(types).not.toContain('CHALLENGE_WON');
  });

  it('a RANKED challenge fires CHALLENGE_WON on completion', async () => {
    const { svc, gamification } = makeCtx({ challenge: { type: 'RANKED' } });
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    await svc.complete('u1', 'ch1', state.attemptId);
    const types = gamification.record.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toContain('CHALLENGE_WON');
  });

  it('a perfect score fires CHALLENGE_PERFECT; a partial score does not', async () => {
    const perfect = makeCtx();
    const s1 = await perfect.svc.startAttempt('u1', 'ch1');
    await perfect.svc.answer('u1', 'ch1', s1.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    await perfect.svc.answer('u1', 'ch1', s1.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    await perfect.svc.complete('u1', 'ch1', s1.attemptId);
    expect(perfect.gamification.record.mock.calls.map((c: any[]) => c[0].type)).toContain('CHALLENGE_PERFECT');

    const partial = makeCtx();
    const s2 = await partial.svc.startAttempt('u1', 'ch1');
    await partial.svc.answer('u1', 'ch1', s2.attemptId, { questionId: 'q1', selectedOptionIds: ['WRONG'] });
    await partial.svc.answer('u1', 'ch1', s2.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    await partial.svc.complete('u1', 'ch1', s2.attemptId);
    expect(partial.gamification.record.mock.calls.map((c: any[]) => c[0].type)).not.toContain('CHALLENGE_PERFECT');
  });

  it('retryMistakes builds a new attempt containing only the wrong questions', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['WRONG'] }); // wrong
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] }); // correct
    await svc.complete('u1', 'ch1', state.attemptId);
    const retry = await svc.retryMistakes('u1', 'ch1', state.attemptId);
    expect(retry.totalQuestions).toBe(1);
    expect(retry.questions[0].id).toBe('q1');
  });

  it('retryMistakes refuses a perfect attempt — nothing to retry', async () => {
    const { svc } = makeCtx();
    const state = await svc.startAttempt('u1', 'ch1');
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q1', selectedOptionIds: ['o1'] });
    await svc.answer('u1', 'ch1', state.attemptId, { questionId: 'q2', selectedOptionIds: ['o2'] });
    await svc.complete('u1', 'ch1', state.attemptId);
    await expect(svc.retryMistakes('u1', 'ch1', state.attemptId)).rejects.toThrow(BadRequestException);
  });
});
