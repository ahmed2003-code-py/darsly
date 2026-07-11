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
      update: jest.fn((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
    },
    lessonProgress: { upsert: jest.fn().mockResolvedValue({}) },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  };
  const access: any = { requireStudentAccess: jest.fn().mockResolvedValue({ studentId: 's1' }) };
  const notifications: any = { create: jest.fn().mockResolvedValue({}) };
  const certificates: any = { checkByLesson: jest.fn().mockResolvedValue(null) };
  const svc = new QuizzesService(prisma, access, notifications, certificates);
  return { svc, prisma, created, notifications, certificates };
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

  it('defers scoring when a short-answer question is present', async () => {
    const { svc, created, certificates } = makeCtx([
      ...QUESTIONS,
      { id: 'q3', type: 'SHORT_ANSWER', prompt: 'explain', options: [], correctOptionId: null, explanation: '', points: 3 },
    ]);
    const res = await svc.submit('u1', 'l1', { answers: { q1: 'o1', q2: 'true', q3: 'my essay' } });
    expect(res.scorePct).toBeNull();
    expect(res.passed).toBeNull();
    expect(res.needsManualGrading).toBe(true);
    expect(created[0].needsManualGrading).toBe(true);
    expect(certificates.checkByLesson).not.toHaveBeenCalled(); // not completed yet
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
