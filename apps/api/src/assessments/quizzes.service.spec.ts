import { QuizzesService } from './quizzes.service';

/**
 * Verifies quiz auto-grading (MCQ/TRUE_FALSE scored instantly), the
 * short-answer → manual-grading path, and the teacher's finalize-score math.
 */
const QUESTIONS: any[] = [
  { id: 'q1', type: 'MCQ', prompt: 'a', options: [], correctOptionId: 'o1', explanation: '', points: 2 },
  { id: 'q2', type: 'TRUE_FALSE', prompt: 'b', options: [], correctOptionId: 'true', explanation: '', points: 1 },
];

function makeCtx(questions = QUESTIONS, quizOver: Record<string, unknown> = {}, aiVerdicts?: Map<string, unknown>) {
  const created: any[] = [];
  const prisma: any = {
    quiz: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'quiz1', lessonId: 'l1', passingScore: 50, questions,
        // Defaults for the settings that used to be stored and never read.
        timeLimitSec: null, shuffleQuestions: false, maxAttempts: null,
        aiGrading: false, aiThresholdPct: 60,
        ...quizOver,
      }),
    },
    quizAttempt: {
      create: jest.fn((args: any) => { created.push(args.data); return Promise.resolve({ id: 'a1', ...args.data }); }),
      findFirst: jest.fn(),
      // The attempt cap ("you get N tries") counts prior attempts before
      // accepting a submission; without this the service throws before it grades.
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
    },
    lessonProgress: { upsert: jest.fn().mockResolvedValue({}) },
    // scopeOf() resolves the academy/course an award belongs to.
    lesson: {
      findUnique: jest.fn().mockResolvedValue({ unit: { courseId: 'c1', course: { tenantId: 't1' } } }),
      update: jest.fn().mockResolvedValue({}),
    },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  };
  const access: any = {
    requireStudentAccess: jest.fn().mockResolvedValue({ studentId: 's1' }),
    requireTeacherLesson: jest.fn().mockResolvedValue({ id: 'l1', unit: { courseId: 'c1' } }),
  };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const certificates: any = { checkByLesson: jest.fn().mockResolvedValue(null) };
  const gamification: any = {
    record: jest.fn().mockResolvedValue({ awarded: false, xp: 0, coins: 0, totalXp: 0, level: 1, leveledUp: false, achievements: [], missions: [] }),
    checkUnitCompletion: jest.fn().mockResolvedValue({ awarded: false }),
    noteStudySession: jest.fn().mockResolvedValue(undefined),
    checkStreakMilestone: jest.fn().mockResolvedValue({ awarded: false }),
  };
  // The marker is asked once per paper and never throws — an empty map is
  // exactly what an outage looks like to the caller, so it is also the default.
  const aiGrader: any = {
    available: true,
    mark: jest.fn().mockResolvedValue(aiVerdicts ?? new Map()),
  };
  const svc = new QuizzesService(prisma, access, notifications, certificates, gamification, aiGrader);
  return { svc, prisma, created, notifications, certificates, gamification, aiGrader };
}

describe('QuizzesService', () => {
  it('auto-grades a fully-correct MCQ/TF attempt to 100% and passes', async () => {
    const { svc, created, certificates } = makeCtx();
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', q2: 'true' } });
    expect(res.scorePct).toBe(100);
    expect(res.passed).toBe(true);
    expect(res.needsManualGrading).toBe(false);
    expect(created[0].scorePct).toBe(100);
    expect(certificates.checkByLesson).toHaveBeenCalledWith('s1', 'l1'); // completion checked
  });

  it('scores a partially-correct attempt by points and fails below passingScore', async () => {
    const { svc } = makeCtx();
    // only q2 (1 of 3 points) correct = 33%
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'wrong', q2: 'true' } });
    expect(res.scorePct).toBe(33);
    expect(res.passed).toBe(false);
  });

  /**
   * An essay puts the essay in a queue, not the paper.
   *
   * The machine set the multiple-choice questions and knows their answers, so
   * it says what it knows straight away. Only the verdict waits, and only while
   * the outstanding points could still change it.
   */
  it('scores what it can and leaves only the essay pending', async () => {
    const { svc, created, certificates } = makeCtx([
      ...QUESTIONS,
      { id: 'q3', type: 'SHORT_ANSWER', prompt: 'explain', options: [], correctOptionId: null, explanation: '', points: 3 },
    ]);
    // 3 of 6 objective points are earned; the 3 essay points could take it to 6.
    // 50% is the pass mark, so it is already decided: passed.
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', q2: 'true', q3: 'my essay' } });
    expect(res.scorePct).toBe(50);
    expect(res.passed).toBe(true);
    expect(res.needsManualGrading).toBe(true);
    expect(res.pendingPoints).toBe(3);
    expect(created[0].needsManualGrading).toBe(true);
  });

  it('waits only while the outstanding points could still change the verdict', async () => {
    const { svc } = makeCtx([
      ...QUESTIONS,
      { id: 'q3', type: 'SHORT_ANSWER', prompt: 'explain', options: [], correctOptionId: null, explanation: '', points: 3 },
    ]);
    // 1 of 6 objective points. The essay's 3 could reach 4/6 = 67%, past the
    // 50% mark — so nobody can say yet.
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'wrong', q2: 'true', q3: 'essay' } });
    expect(res.scorePct).toBe(17);
    expect(res.passed).toBeNull();
    expect(res.needsManualGrading).toBe(true);
  });

  it('says failed when every remaining point would still not be enough', async () => {
    const { svc } = makeCtx([
      ...QUESTIONS,
      { id: 'q3', type: 'SHORT_ANSWER', prompt: 'explain', options: [], correctOptionId: null, explanation: '', points: 1 },
    ]);
    // 0 of 3 objective points and 1 left with the teacher: 1/4 = 25%, under the
    // mark whatever the essay scores. Telling them to wait would be a fiction.
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'wrong', q2: 'false', q3: 'essay' } });
    expect(res.passed).toBe(false);
    expect(res.needsManualGrading).toBe(true);
  });

  /** A question that asks for two answers is not two questions worth a half. */
  it('takes every right option, or none of the marks', async () => {
    const { svc } = makeCtx([
      { id: 'm1', type: 'MCQ', prompt: 'pick two', options: [], correctOptionId: 'a',
        correctOptionIds: ['a', 'b'], explanation: '', points: 2 },
    ]);
    expect((await svc.submit('u1', 'l1', { answers: { m1: ['a', 'b'] } })).scorePct).toBe(100);
    expect((await svc.submit('u1', 'l1', { answers: { m1: ['b', 'a'] } })).scorePct).toBe(100);
    expect((await svc.submit('u1', 'l1', { answers: { m1: ['a'] } })).scorePct).toBe(0);
    expect((await svc.submit('u1', 'l1', { answers: { m1: ['a', 'b', 'c'] } })).scorePct).toBe(0);
    expect((await svc.submit('u1', 'l1', { answers: { m1: 'a' } })).scorePct).toBe(0);
  });

  it('finalizes the score when the teacher grades short-answer points', async () => {
    const { svc, prisma, notifications } = makeCtx();
    prisma.quizAttempt.findFirst.mockResolvedValue({
      id: 'a1', studentId: 's1', answers: { q1: 'o1', q2: 'false', q3: 'essay' },
      quiz: {
        id: 'quiz1', lessonId: 'l1', passingScore: 50, lesson: { title: 'L' },
        questions: [
          { id: 'q1', type: 'MCQ', correctOptionId: 'o1', points: 2 },
          { id: 'q2', type: 'TRUE_FALSE', correctOptionId: 'true', points: 1 },
          { id: 'q3', type: 'SHORT_ANSWER', correctOptionId: null, points: 3 },
        ],
      },
    });
    // q1 correct (2), q2 wrong (0), q3 awarded 3 → 5/6 = 83%
    const res = await svc.gradeAttempt('t1', 'teacherUser', 'a1', { scores: { q3: 3 } });
    expect(res.scorePct).toBe(83);
    expect(res.passed).toBe(true);
    expect(res.needsManualGrading).toBe(false);
    expect(notifications.create).toHaveBeenCalled();
  });
});

/**
 * The three settings the schema described and nothing read, and the marker that
 * replaced the teacher's queue for written answers.
 *
 * Each case here is about the student's side of it, because that is where
 * getting this wrong costs marks they earned or time they were owed.
 */
describe('the settings that used to be decoration', () => {
  const ESSAY: any[] = [
    { id: 'q1', type: 'MCQ', prompt: 'a', options: [], correctOptionId: 'o1', explanation: '', points: 1 },
    { id: 'e1', type: 'SHORT_ANSWER', prompt: 'why?', options: [], correctOptionId: null,
      modelAnswer: 'because of X', explanation: '', points: 1 },
  ];

  describe('marking a written answer against the model answer', () => {
    it('awards the marks at or above the threshold', async () => {
      const { svc } = makeCtx(ESSAY, { aiGrading: true, aiThresholdPct: 60 },
        new Map([['e1', { similarityPct: 72, reason: 'covers X' }]]));
      const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', e1: 'X is why' } });
      // Both questions marked, nothing left for the teacher.
      expect(res.scorePct).toBe(100);
      expect(res.passed).toBe(true);
      expect(res.needsManualGrading).toBe(false);
      expect(res.aiFeedback).toMatchObject({ e1: { similarityPct: 72, awarded: true } });
    });

    it('awards nothing below it, and still does not wait for the teacher', async () => {
      const { svc } = makeCtx(ESSAY, { aiGrading: true, aiThresholdPct: 60 },
        new Map([['e1', { similarityPct: 41, reason: 'misses X' }]]));
      const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', e1: 'something else' } });
      expect(res.scorePct).toBe(50);
      expect(res.needsManualGrading).toBe(false);
      expect(res.aiFeedback).toMatchObject({ e1: { awarded: false } });
    });

    it('counts the threshold itself as a pass, not a near miss', async () => {
      const { svc } = makeCtx(ESSAY, { aiGrading: true, aiThresholdPct: 60 },
        new Map([['e1', { similarityPct: 60, reason: 'just about' }]]));
      expect((await svc.submit('u1', 'l1', { answers: { e1: 'x' } })).aiFeedback).toMatchObject({
        e1: { awarded: true },
      });
    });

    /**
     * The rule the whole thing rests on. An outage, a refusal, a provider that
     * timed out - none of them may cost a student marks. The answer goes to the
     * teacher exactly as it did before any of this existed.
     */
    it('hands the answer to the teacher when it cannot judge it', async () => {
      const { svc } = makeCtx(ESSAY, { aiGrading: true }, new Map()); // marker returned nothing
      // The MCQ is answered wrongly on purpose, so the paper genuinely hangs on
      // the written answer: 0 of 2 so far, 1 mark still in play, pass mark 50%.
      // With the MCQ right the existing partial marking would already have
      // decided a pass, and this would be testing that instead.
      const res = await svc.submit('u1', 'l1', { answers: { q1: 'wrong', e1: 'a real answer' } });
      expect(res.needsManualGrading).toBe(true);
      expect(res.pendingPoints).toBe(1);
      // Not marked wrong: the verdict is still open, so there is no verdict yet.
      expect(res.passed).toBe(null);
    });

    it('does not wait on an answer left blank', async () => {
      const { svc } = makeCtx(ESSAY, { aiGrading: true }, new Map());
      const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', e1: '   ' } });
      expect(res.needsManualGrading).toBe(false);
      expect(res.scorePct).toBe(50);
    });

    it('is never asked at all when the teacher did not turn it on', async () => {
      const { svc, aiGrader } = makeCtx(ESSAY);
      const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', e1: 'an answer' } });
      expect(aiGrader.mark).not.toHaveBeenCalled();
      expect(res.needsManualGrading).toBe(true);
    });
  });

  describe('a time limit that is actually a limit', () => {
    const TIMED = { timeLimitSec: 600 };

    it('reuses the sitting whose clock is already running', async () => {
      const { svc, prisma } = makeCtx(QUESTIONS, TIMED);
      prisma.quizAttempt.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.submittedAt === null
          ? { id: 'open1', startedAt: new Date(Date.now() - 60_000) }
          : null),
      );
      await svc.submit('u1', 'l1', { answers: { q1: 'o1', q2: 'true' } });
      // Submitted into the open row rather than opening a second one, which
      // would spend two attempts on a single sitting.
      expect(prisma.quizAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'open1' } }),
      );
      expect(prisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('refuses a paper sent after time is up, and spends the attempt', async () => {
      const { svc, prisma } = makeCtx(QUESTIONS, TIMED);
      prisma.quizAttempt.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.submittedAt === null
          ? { id: 'open1', startedAt: new Date(Date.now() - 3_600_000) }
          : null),
      );
      await expect(svc.submit('u1', 'l1', { answers: { q1: 'o1' } })).rejects.toMatchObject({
        response: { code: 'QUIZ_TIME_UP' },
      });
      // Closed as sat-and-failed rather than thrown away: a refusal that left no
      // record would let the same sitting be retried until the answers were right.
      expect(prisma.quizAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'open1' },
          data: expect.objectContaining({ passed: false, scorePct: 0 }),
        }),
      );
    });

    it('leaves an untimed paper exactly as it was', async () => {
      const { svc, prisma } = makeCtx();
      await svc.submit('u1', 'l1', { answers: { q1: 'o1', q2: 'true' } });
      // No sitting is opened, so abandoning an untimed quiz still costs nothing.
      expect(prisma.quizAttempt.create).toHaveBeenCalled();
    });
  });

  describe('giving a student their attempts back', () => {
    it('voids them rather than deleting what they wrote', async () => {
      const { svc, prisma, notifications } = makeCtx();
      prisma.enrollment = { findFirst: jest.fn().mockResolvedValue({ id: 'e1' }) };
      prisma.quizAttempt.updateMany = jest.fn().mockResolvedValue({ count: 3 });
      const res = await svc.resetAttemptsFor('t1', 'l1', 's1');
      expect(res).toEqual({ voided: 3 });
      expect(prisma.quizAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { voidedAt: expect.any(Date) } }),
      );
      // The student is told, or they have no reason to go back and look.
      expect(notifications.create).toHaveBeenCalled();
    });

    it('will not reach a student who is not in this academy', async () => {
      const { svc, prisma } = makeCtx();
      prisma.enrollment = { findFirst: jest.fn().mockResolvedValue(null) };
      prisma.quizAttempt.updateMany = jest.fn();
      await expect(svc.resetAttemptsFor('t1', 'l1', 'someone-elses')).rejects.toThrow();
      expect(prisma.quizAttempt.updateMany).not.toHaveBeenCalled();
    });
  });
});

/**
 * Saving a quiz for the very first time.
 *
 * The builder saves the question set and the settings as two calls. Which order
 * they go in is not a free choice: the settings call is what used to create the
 * quiz row, and the question call used to refuse without one - so when the
 * order was reversed (so that switching automatic marking on could be checked
 * against the model answers in the same edit), the first save of every new quiz
 * started failing with "create the quiz before adding questions", on a lesson
 * whose questions were sitting right there.
 */
describe('the first save of a new quiz', () => {
  function ctx(existing: unknown = null) {
    const prisma: any = {
      quiz: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest.fn(async (args: any) => existing ?? { id: 'quiz1', lessonId: 'l1', aiGrading: false, ...args.create }),
      },
      quizQuestion: { deleteMany: jest.fn(), create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const access: any = {
      requireTeacherLesson: jest.fn().mockResolvedValue({ id: 'l1', unit: { courseId: 'c1' } }),
    };
    const svc = new QuizzesService(prisma, access, {} as any, {} as any, {} as any, {} as any);
    // getForTeacher is the return value and has its own coverage; the subject
    // here is whether the write went through at all.
    jest.spyOn(svc, 'getForTeacher').mockResolvedValue({} as any);
    return { svc, prisma };
  }

  it('creates the quiz rather than refusing the questions', async () => {
    const { svc, prisma } = ctx(null);
    await expect(
      svc.setQuestions('t1', 'l1', { questions: [{ prompt: 'why', type: 'MCQ' } as any] }),
    ).resolves.toBeDefined();
    expect(prisma.quiz.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lessonId: 'l1' }, create: { lessonId: 'l1' } }),
    );
  });

  it("leaves an existing quiz's settings alone", async () => {
    const { svc, prisma } = ctx({ id: 'quiz1', lessonId: 'l1', passingScore: 80, aiGrading: false });
    await svc.setQuestions('t1', 'l1', { questions: [{ prompt: 'why', type: 'MCQ' } as any] });
    // An empty update: saving questions is not the call that changes settings.
    expect(prisma.quiz.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });
});

/**
 * Coming back to a paper you have already sat.
 *
 * The page used to open on a blank paper with a running clock whatever had
 * happened before, so a student who finished and closed it came back to what
 * looked like a fresh exam — and once the clock was real, merely opening it
 * started a sitting and spent an attempt.
 *
 * Three things hang off one question — is there anything left to gain from
 * sitting it again — and they must never disagree: whether a retake is offered,
 * whether the clock starts, and whether the answer key is handed over.
 */
describe('a paper that has already been sat', () => {
  const PAPER: any[] = [
    { id: 'q1', type: 'MCQ', prompt: 'a', options: [], correctOptionId: 'o1',
      correctOptionIds: ['o1'], modelAnswer: '', explanation: 'because', points: 1 },
    { id: 'q2', type: 'MCQ', prompt: 'b', options: [], correctOptionId: 'o2',
      correctOptionIds: ['o2'], modelAnswer: '', explanation: '', points: 1 },
  ];

  function ctx(quizOver: Record<string, unknown>, attempts: any[]) {
    const created: any[] = [];
    const prisma: any = {
      quiz: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'quiz1', lessonId: 'l1', passingScore: 50, questions: PAPER,
          timeLimitSec: null, shuffleQuestions: false, maxAttempts: null,
          aiGrading: false, aiThresholdPct: 60, showAnswers: true,
          ...quizOver,
        }),
      },
      quizAttempt: {
        findMany: jest.fn().mockResolvedValue(attempts),
        // Opening a sitting looks for one already running before it starts a
        // new one, so a reload does not buy more time.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (a: any) => { created.push(a.data); return { id: 'new', startedAt: new Date(), ...a.data }; }),
      },
    };
    const access: any = { requireStudentAccess: jest.fn().mockResolvedValue({ studentId: 's1' }) };
    const svc = new QuizzesService(prisma, access, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma, created };
  }

  const sitting = (scorePct: number | null, passed: boolean | null = true) => ({
    id: 'a1', scorePct, passed, needsManualGrading: false,
    submittedAt: new Date('2026-09-14T12:00:00Z'),
    answers: { q1: 'o1' }, aiFeedback: null,
  });

  it('hands back the result and the answers they gave', async () => {
    const { svc } = ctx({ maxAttempts: 1 }, [sitting(50)]);
    const view = await svc.getForStudent('u1', 'l1');
    expect(view.lastAttempt).toMatchObject({ scorePct: 50, answers: { q1: 'o1' } });
    // Their own paper, so the page renders it filled in instead of empty.
    expect(view.attemptsUsed).toBe(1);
  });

  it('does not start a clock on a paper they cannot sit again', async () => {
    // This is what spent an attempt just for opening the page.
    const { svc, prisma } = ctx({ maxAttempts: 1, timeLimitSec: 600 }, [sitting(50)]);
    const view = await svc.getForStudent('u1', 'l1');
    expect(prisma.quizAttempt.create).not.toHaveBeenCalled();
    expect(view.deadlineAt).toBeNull();
  });

  it('does start one when they still have a go left', async () => {
    const { svc, prisma } = ctx({ maxAttempts: 3, timeLimitSec: 600 }, [sitting(50)]);
    const view = await svc.getForStudent('u1', 'l1');
    expect(prisma.quizAttempt.create).toHaveBeenCalled();
    expect(view.deadlineAt).not.toBeNull();
  });

  it('ignores a sitting that was opened and never sent', async () => {
    // An abandoned row is not a result and must not be shown as one.
    const { svc, prisma } = ctx({}, []);
    await svc.getForStudent('u1', 'l1');
    expect(prisma.quizAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ submittedAt: { not: null } }) }),
    );
  });

  describe('offering another go', () => {
    it('offers one below full marks while attempts remain', async () => {
      const { svc } = ctx({ maxAttempts: 3 }, [sitting(60)]);
      expect((await svc.getForStudent('u1', 'l1')).canSitAgain).toBe(true);
    });

    it('offers one even though they passed — 60% is worth improving', async () => {
      const { svc } = ctx({}, [sitting(60, true)]);
      expect((await svc.getForStudent('u1', 'l1')).canSitAgain).toBe(true);
    });

    it('offers none on a one-attempt paper', async () => {
      const { svc } = ctx({ maxAttempts: 1 }, [sitting(40, false)]);
      expect((await svc.getForStudent('u1', 'l1')).canSitAgain).toBe(false);
    });

    it('offers none at full marks, however many attempts are left', async () => {
      const { svc } = ctx({ maxAttempts: 5 }, [sitting(100)]);
      expect((await svc.getForStudent('u1', 'l1')).canSitAgain).toBe(false);
    });

    it('counts their best sitting, not their last', async () => {
      const { svc } = ctx({ maxAttempts: 5 }, [sitting(40, false), sitting(100)]);
      const view = await svc.getForStudent('u1', 'l1');
      expect(view.bestScorePct).toBe(100);
      expect(view.canSitAgain).toBe(false);
    });
  });

  describe('handing over the answer key', () => {
    it('gives it up when there is no attempt left to spend it on', async () => {
      // The case asked for: one attempt, so the student sees their whole paper
      // with the answers.
      const { svc } = ctx({ maxAttempts: 1 }, [sitting(40, false)]);
      const view = await svc.getForStudent('u1', 'l1');
      expect(view.review).toHaveLength(2);
      expect(view.review[0]).toMatchObject({ correctOptionIds: ['o1'], explanation: 'because' });
    });

    it('withholds it while they could still use it to score better', async () => {
      // Answers plus a spare attempt is a slower way of giving out full marks.
      const { svc } = ctx({ maxAttempts: 3 }, [sitting(40, false)]);
      expect((await svc.getForStudent('u1', 'l1')).review).toEqual([]);
    });

    it('withholds it when the teacher said not to show it', async () => {
      const { svc } = ctx({ maxAttempts: 1, showAnswers: false }, [sitting(40, false)]);
      const view = await svc.getForStudent('u1', 'l1');
      expect(view.review).toEqual([]);
      // Their score and their own answers still come back — it is the key that
      // is withheld, not their paper.
      expect(view.lastAttempt).toMatchObject({ scorePct: 40, answers: { q1: 'o1' } });
    });

    it('has nothing to reveal before they have sat it at all', async () => {
      const { svc } = ctx({ maxAttempts: 1 }, []);
      expect((await svc.getForStudent('u1', 'l1')).review).toEqual([]);
    });
  });
});
