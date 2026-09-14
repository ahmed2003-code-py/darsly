import { QuizzesService } from './quizzes.service';

/**
 * Verifies quiz auto-grading (MCQ/TRUE_FALSE scored instantly), the
 * short-answer → manual-grading path, and the teacher's finalize-score math.
 */
const QUESTIONS: any[] = [
  { id: 'q1', type: 'MCQ', prompt: 'a', options: [], correctOptionId: 'o1', explanation: '', points: 2 },
  { id: 'q2', type: 'TRUE_FALSE', prompt: 'b', options: [], correctOptionId: 'true', explanation: '', points: 1 },
];

function makeCtx(questions = QUESTIONS) {
  const created: any[] = [];
  const prisma: any = {
    quiz: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'quiz1', lessonId: 'l1', passingScore: 50, questions,
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
  const access: any = { requireStudentAccess: jest.fn().mockResolvedValue({ studentId: 's1' }) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const certificates: any = { checkByLesson: jest.fn().mockResolvedValue(null) };
  const gamification: any = {
    record: jest.fn().mockResolvedValue({ awarded: false, xp: 0, coins: 0, totalXp: 0, level: 1, leveledUp: false, achievements: [], missions: [] }),
    checkUnitCompletion: jest.fn().mockResolvedValue({ awarded: false }),
    noteStudySession: jest.fn().mockResolvedValue(undefined),
    checkStreakMilestone: jest.fn().mockResolvedValue({ awarded: false }),
  };
  const svc = new QuizzesService(prisma, access, notifications, certificates, gamification);
  return { svc, prisma, created, notifications, certificates, gamification };
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
