import { GradingService } from './grading.service';

/**
 * The marking queue. Two things matter here above all: that it never reaches
 * another teacher's work, and that the student who has been waiting longest is
 * the one a teacher sees first.
 */
const lessonOf = (courseId: string, courseTitle: string, lessonTitle: string) => ({
  id: 'l-' + lessonTitle, title: lessonTitle,
  unit: { title: 'الوحدة الأولى', course: { id: courseId, title: courseTitle } },
});
const attempt = (id: string, at: string, courseId = 'c1', course = 'الجبر') => ({
  id, submittedAt: new Date(at),
  student: { user: { fullName: 'طالب ' + id } },
  quiz: { lesson: lessonOf(courseId, course, 'درس ' + id) },
});
const submission = (id: string, at: string, courseId = 'c1', course = 'الجبر') => ({
  id, createdAt: new Date(at),
  student: { user: { fullName: 'طالب ' + id } },
  assignment: { lesson: lessonOf(courseId, course, 'درس ' + id) },
});

function svc(attempts: any[], submissions: any[]) {
  const seen: any = {};
  const prisma: any = {
    quizAttempt: { findMany: jest.fn(async (a: any) => { seen.attemptWhere = a.where; return attempts; }) },
    assignmentSubmission: { findMany: jest.fn(async (a: any) => { seen.subWhere = a.where; return submissions; }) },
  };
  return { s: new GradingService(prisma, { create: jest.fn() } as any), seen };
}

describe('the marking queue', () => {
  it('only ever looks inside this teacher\'s own courses', async () => {
    const { s, seen } = svc([], []);
    await s.queue('t1');
    expect(seen.attemptWhere.quiz.lesson.unit.course.tenantId).toBe('t1');
    expect(seen.subWhere.assignment.lesson.unit.course.tenantId).toBe('t1');
  });

  it('asks only for work that is actually waiting', async () => {
    const { s, seen } = svc([], []);
    await s.queue('t1');
    expect(seen.attemptWhere).toMatchObject({
      needsManualGrading: true,
      gradedAt: null,
      voidedAt: null,              // an attempt handed back is not waiting
      submittedAt: { not: null },  // nor is one still being written
    });
    expect(seen.subWhere.gradedAt).toBeNull();
  });

  it('groups quizzes and assignments together under their course', async () => {
    const { s } = svc([attempt('a1', '2026-09-01')], [submission('s1', '2026-09-02')]);
    const out = await s.queue('t1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ courseId: 'c1', courseTitle: 'الجبر', pending: 2 });
    expect(out[0].items.map((i: any) => i.kind)).toEqual(['QUIZ', 'ASSIGNMENT']);
  });

  it('puts the student who has waited longest first', async () => {
    const { s } = svc(
      [attempt('newer', '2026-09-10'), attempt('older', '2026-09-01')],
      [submission('middle', '2026-09-05')],
    );
    const out = await s.queue('t1');
    expect(out[0].items.map((i: any) => i.id)).toEqual(['older', 'middle', 'newer']);
  });

  it('puts the course with the most waiting at the top', async () => {
    const { s } = svc(
      [attempt('a1', '2026-09-01', 'c1', 'الجبر'), attempt('a2', '2026-09-02', 'c2', 'الهندسة'), attempt('a3', '2026-09-03', 'c2', 'الهندسة')],
      [],
    );
    const out = await s.queue('t1');
    expect(out.map((c: any) => [c.courseId, c.pending])).toEqual([['c2', 2], ['c1', 1]]);
  });

  it('is an empty list, not a failure, when there is nothing to mark', async () => {
    const { s } = svc([], []);
    await expect(s.queue('t1')).resolves.toEqual([]);
  });
});
