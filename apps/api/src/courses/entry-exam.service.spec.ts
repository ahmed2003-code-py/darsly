import { ForbiddenException } from '@nestjs/common';
import { EntryExamService } from './entry-exam.service';

/**
 * This decides whether a paying student can open the thing they paid for, so
 * the cases that matter are the ones where it says no: it must say no only when
 * a teacher has actually asked for an exam, and it must always leave a way
 * forward — the exam itself, and whatever the exam sends them to watch.
 */
function ctx(over: {
  examLessonId?: string | null;
  remedialLessonId?: string | null;
  attempts?: { passed: boolean | null; scorePct: number | null; needsManualGrading?: boolean; gradedAt?: Date | null }[];
} = {}) {
  const prisma: any = {
    course: { findFirst: jest.fn().mockResolvedValue({ examLessonId: over.examLessonId ?? null }) },
    quiz: {
      findUnique: jest.fn().mockResolvedValue(
        over.examLessonId ? { id: 'quiz1', remedialLessonId: over.remedialLessonId ?? null } : null,
      ),
    },
    quizAttempt: {
      findMany: jest.fn().mockResolvedValue(
        (over.attempts ?? []).map((a) => ({
          passed: a.passed,
          scorePct: a.scorePct,
          needsManualGrading: a.needsManualGrading ?? false,
          gradedAt: a.gradedAt ?? null,
        })),
      ),
    },
  };
  return { svc: new EntryExamService(prisma), prisma };
}

describe('EntryExamService', () => {
  /**
   * The rule that makes this safe to add to a platform already full of courses:
   * a course that names no exam is not gated by anything.
   */
  it('gates nothing when no exam is named', async () => {
    const { svc, prisma } = ctx();
    const state = await svc.stateFor('c1', 's1');
    expect(state).toEqual({
      lessonId: null, passed: true, attempted: false,
      remedialLessonId: null, bestScorePct: null, awaitingGrading: false,
    });
    // And it does not go looking for attempts it has no reason to want.
    expect(prisma.quizAttempt.findMany).not.toHaveBeenCalled();
    await expect(svc.requirePassed('c1', 's1', 'any-lesson', false)).resolves.toBeDefined();
  });

  it('shuts the course until the exam is passed', async () => {
    const { svc } = ctx({ examLessonId: 'exam', attempts: [] });
    await expect(svc.requirePassed('c1', 's1', 'lesson-2', false)).rejects.toThrow(ForbiddenException);
  });

  /** A refusal with no way forward is a dead end, not a gate. */
  it('always leaves the exam and its remedy open', async () => {
    const { svc } = ctx({ examLessonId: 'exam', remedialLessonId: 'watch-this', attempts: [] });
    await expect(svc.requirePassed('c1', 's1', 'exam', false)).resolves.toBeDefined();
    await expect(svc.requirePassed('c1', 's1', 'watch-this', false)).resolves.toBeDefined();
  });

  /** The shop window stays open, or the course disappears for anyone deciding. */
  it('leaves a free preview free', async () => {
    const { svc } = ctx({ examLessonId: 'exam', attempts: [] });
    await expect(svc.requirePassed('c1', 's1', 'teaser', true)).resolves.toBeDefined();
  });

  it('opens everything once they pass', async () => {
    const { svc } = ctx({ examLessonId: 'exam', attempts: [{ passed: true, scorePct: 80 }] });
    const state = await svc.stateFor('c1', 's1');
    expect(state.passed).toBe(true);
    await expect(svc.requirePassed('c1', 's1', 'lesson-2', false)).resolves.toBeDefined();
  });

  /** One pass is a pass, however many attempts came before it. */
  it('remembers a pass among failures, and keeps the best score', async () => {
    const { svc } = ctx({
      examLessonId: 'exam',
      attempts: [
        { passed: false, scorePct: 20 },
        { passed: true, scorePct: 70 },
        { passed: false, scorePct: 40 },
      ],
    });
    const state = await svc.stateFor('c1', 's1');
    expect(state.passed).toBe(true);
    expect(state.attempted).toBe(true);
    expect(state.bestScorePct).toBe(70);
  });

  it('says when a verdict is genuinely with the teacher', async () => {
    const { svc } = ctx({
      examLessonId: 'exam',
      attempts: [{ passed: null, scorePct: 40, needsManualGrading: true, gradedAt: null }],
    });
    const state = await svc.stateFor('c1', 's1');
    expect(state.awaitingGrading).toBe(true);
    expect(state.passed).toBe(false);
  });

  /** A decided result is not waiting on anybody, essay or no essay. */
  it('is not waiting when the result is already decided', async () => {
    const { svc } = ctx({
      examLessonId: 'exam',
      attempts: [{ passed: true, scorePct: 60, needsManualGrading: true, gradedAt: null }],
    });
    expect((await svc.stateFor('c1', 's1')).awaitingGrading).toBe(false);
  });

  /** Somebody not signed in has nothing to have passed; the exam is the door. */
  it('shows a visitor the exam without pretending they failed it', async () => {
    const { svc, prisma } = ctx({ examLessonId: 'exam' });
    const state = await svc.stateFor('c1', null);
    expect(state.lessonId).toBe('exam');
    expect(state.passed).toBe(false);
    expect(state.attempted).toBe(false);
    expect(prisma.quizAttempt.findMany).not.toHaveBeenCalled();
  });

  /**
   * A named exam with no quiz behind it yet — the teacher made the lesson and
   * has not written the questions. It must not lock the course on a paper that
   * does not exist.
   */
  it('does not lock a course on an exam that has no questions yet', async () => {
    const { svc } = ctx({ examLessonId: 'exam' });
    const state = await svc.stateFor('c1', 's1');
    expect(state.lessonId).toBe('exam');
    // The exam is still the only way in, and it is reachable.
    expect(svc.isAllowedWhileLocked(state, 'exam', false)).toBe(true);
    expect(svc.isAllowedWhileLocked(state, 'other', false)).toBe(false);
  });

  it('names the exam in the refusal, so the client can send them to it', async () => {
    const { svc } = ctx({ examLessonId: 'exam', remedialLessonId: 'watch-this', attempts: [] });
    await expect(svc.requirePassed('c1', 's1', 'lesson-2', false)).rejects.toMatchObject({
      response: { code: 'ENTRY_EXAM_REQUIRED', examLessonId: 'exam', remedialLessonId: 'watch-this' },
    });
  });
});
