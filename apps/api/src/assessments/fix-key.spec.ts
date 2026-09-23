import { GradingService } from './grading.service';

/**
 * Correcting a key that was typed in wrong.
 *
 * The rule the whole thing rests on: **a correction never lowers anybody's
 * mark.** Students who picked the option the old key called right did nothing
 * wrong, and taking their marks away to fix our typo punishes them for it.
 * Students who picked the option that was right all along get what they earned.
 *
 * The regrade works on the difference this one question makes rather than by
 * re-marking the paper, because a mixed paper's written questions were marked
 * by hand and only the final percentage was ever stored.
 */
const OPTIONS = [
  { id: 'a', text: 'أ' },
  { id: 'b', text: 'ب' },
  { id: 'c', text: 'ج' },
];

function ctx(over: { attempts?: any[]; type?: string; oldKey?: string[] } = {}) {
  const updates: any[] = [];
  const question = {
    id: 'q1',
    type: over.type ?? 'MCQ',
    points: 10,
    options: OPTIONS,
    correctOptionId: (over.oldKey ?? ['a'])[0],
    correctOptionIds: over.oldKey ?? ['a'],
    // 40 marks on the paper, so this question is a quarter of it.
    quiz: {
      id: 'quiz1',
      passingScore: 50,
      lessonId: 'l1',
      lesson: { title: 'الدرس' },
      questions: [{ points: 10 }, { points: 30 }],
    },
  };
  const prisma: any = {
    quizQuestion: {
      findFirst: jest.fn().mockResolvedValue(question),
      update: jest.fn(async (a: any) => {
        updates.push({ kind: 'key', ...a.data });
        return a.data;
      }),
    },
    quizAttempt: {
      findMany: jest.fn().mockResolvedValue(over.attempts ?? []),
      update: jest.fn(async (a: any) => {
        updates.push({ kind: 'attempt', id: a.where.id, ...a.data });
        return a.data;
      }),
    },
    questionReport: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    studentProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  };
  const svc = new GradingService(prisma, { create: jest.fn() } as any);
  return {
    svc,
    prisma,
    updates,
    scoreOf: (id: string) => updates.find((u) => u.kind === 'attempt' && u.id === id),
  };
}

const attempt = (id: string, chose: string, scorePct: number) => ({
  id,
  studentId: 's-' + id,
  scorePct,
  answers: { q1: chose },
});

describe('correcting a question key', () => {
  it('writes the new key on the question', async () => {
    const { svc, prisma } = ctx();
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(prisma.quizQuestion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { correctOptionIds: ['b'], correctOptionId: 'b' } }),
    );
  });

  it('raises the mark of a student who was right all along', async () => {
    // Key said "a"; the real answer is "b". This student answered b and was
    // marked down for it: 40% becomes 65% (10 of 40 marks = 25 points).
    const { svc, scoreOf } = ctx({ attempts: [attempt('A', 'b', 40)] });
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(scoreOf('A')).toMatchObject({ scorePct: 65, passed: true });
  });

  it('does NOT take the mark back from a student who picked the old key', async () => {
    // They answered "a" when the key said "a". Not their mistake.
    const { svc, scoreOf } = ctx({ attempts: [attempt('B', 'a', 90)] });
    const out = await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(scoreOf('B')).toBeUndefined();
    expect(out.raised).toBe(0);
  });

  it('leaves alone a student the change makes no difference to', async () => {
    const { svc, scoreOf } = ctx({ attempts: [attempt('C', 'c', 50)] });
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(scoreOf('C')).toBeUndefined();
  });

  it('recomputes whether they passed, at the new mark', async () => {
    // 30% + 25 points = 55%, which clears a passing score of 50.
    const { svc, scoreOf } = ctx({ attempts: [attempt('D', 'b', 30)] });
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(scoreOf('D')).toMatchObject({ scorePct: 55, passed: true });
  });

  it('never pushes a mark above full', async () => {
    const { svc, scoreOf } = ctx({ attempts: [attempt('E', 'b', 95)] });
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(scoreOf('E')!.scorePct).toBe(100);
  });

  it('only looks at papers that already carry a mark', async () => {
    const { svc, prisma } = ctx();
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(prisma.quizAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          needsManualGrading: false, // still being marked: it will meet the new key then
          voidedAt: null,
          submittedAt: { not: null },
          scorePct: { not: null },
        }),
      }),
    );
  });

  it('answers the students who complained', async () => {
    const { svc, prisma } = ctx();
    const out = await svc.fixKey('t1', 'u-teacher', 'q1', ['b']);
    expect(prisma.questionReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { questionId: 'q1', status: 'OPEN' },
        data: expect.objectContaining({ status: 'ACCEPTED', resolvedBy: 'u-teacher' }),
      }),
    );
    expect(out.reportsAccepted).toBe(3);
  });

  it('refuses a key that names no option on the question', async () => {
    const { svc } = ctx();
    await expect(svc.fixKey('t1', 'u-teacher', 'q1', ['zzz'])).rejects.toThrow();
  });

  it('refuses a written question, which has no key', async () => {
    const { svc } = ctx({ type: 'SHORT_ANSWER' });
    await expect(svc.fixKey('t1', 'u-teacher', 'q1', ['b'])).rejects.toThrow();
  });

  it('handles a question that accepts more than one option', async () => {
    // "choose two": naming both is right, naming one is not.
    const { svc, scoreOf } = ctx({
      attempts: [{ id: 'F', studentId: 's-F', scorePct: 50, answers: { q1: ['b', 'c'] } }],
    });
    await svc.fixKey('t1', 'u-teacher', 'q1', ['b', 'c']);
    expect(scoreOf('F')).toMatchObject({ scorePct: 75 });
  });

  it("cannot reach a question in another teacher's course", async () => {
    const { svc, prisma } = ctx();
    prisma.quizQuestion.findFirst.mockResolvedValue(null);
    await expect(svc.fixKey('t1', 'u-teacher', 'q1', ['b'])).rejects.toThrow();
    expect(
      prisma.quizQuestion.findFirst.mock.calls[0][0].where.quiz.lesson.unit.course.tenantId,
    ).toBe('t1');
  });
});
