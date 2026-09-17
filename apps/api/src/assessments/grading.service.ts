import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Everything of this teacher's that is waiting to be marked, in one place.
 *
 * Marking used to live in a narrow column beside the quiz builder, one lesson
 * at a time: to find the three essays waiting across a course a teacher had to
 * remember which lessons had quizzes, open each one, and read a list squeezed
 * into a sidebar. There was no screen anywhere that answered "what do I owe my
 * students today", so the honest answer was usually "no idea".
 *
 * This is that screen. It asks the question the other way round — start from
 * the work, not from the lesson it happens to live in — and it is the only
 * place that has to know quizzes and assignments are two different tables.
 *
 * Scoping is by `course.tenantId`, the teacher's own id, on every query here.
 * There is no path through this service that reads another teacher's work.
 */
@Injectable()
export class GradingService {
  constructor(private readonly prisma: PrismaService) {}

  /** A safety rail, not a page size: nobody has this much waiting. */
  private static readonly MAX_ITEMS = 400;

  /**
   * The queue, grouped by course.
   *
   * Both halves are fetched whole rather than paged: a teacher with more than a
   * few hundred unmarked papers has a different problem from the one this
   * screen solves, and the cap keeps a runaway query honest.
   */
  async queue(tenantId: string) {
    const [attempts, submissions] = await Promise.all([
      this.prisma.quizAttempt.findMany({
        where: {
          needsManualGrading: true,
          gradedAt: null,
          voidedAt: null,
          submittedAt: { not: null },
          quiz: { lesson: { deletedAt: null, unit: { course: { tenantId, deletedAt: null } } } },
        },
        orderBy: { submittedAt: 'asc' },
        take: GradingService.MAX_ITEMS,
        select: {
          id: true,
          submittedAt: true,
          student: { select: { user: { select: { fullName: true } } } },
          quiz: {
            select: {
              lesson: {
                select: {
                  id: true, title: true,
                  unit: { select: { title: true, course: { select: { id: true, title: true } } } },
                },
              },
            },
          },
        },
      }),
      this.prisma.assignmentSubmission.findMany({
        where: {
          gradedAt: null,
          assignment: { lesson: { deletedAt: null, unit: { course: { tenantId, deletedAt: null } } } },
        },
        orderBy: { createdAt: 'asc' },
        take: GradingService.MAX_ITEMS,
        select: {
          id: true,
          createdAt: true,
          student: { select: { user: { select: { fullName: true } } } },
          assignment: {
            select: {
              lesson: {
                select: {
                  id: true, title: true,
                  unit: { select: { title: true, course: { select: { id: true, title: true } } } },
                },
              },
            },
          },
        },
      }),
    ]);

    type Item = {
      id: string;
      kind: 'QUIZ' | 'ASSIGNMENT';
      studentName: string;
      lessonId: string;
      lessonTitle: string;
      unitTitle: string;
      submittedAt: Date | null;
    };
    const courses = new Map<string, { courseId: string; courseTitle: string; items: Item[] }>();
    const push = (courseId: string, courseTitle: string, item: Item) => {
      const row = courses.get(courseId) ?? { courseId, courseTitle, items: [] };
      row.items.push(item);
      courses.set(courseId, row);
    };

    for (const a of attempts) {
      const lesson = a.quiz.lesson;
      push(lesson.unit.course.id, lesson.unit.course.title, {
        id: a.id,
        kind: 'QUIZ',
        studentName: a.student.user.fullName,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        unitTitle: lesson.unit.title,
        submittedAt: a.submittedAt,
      });
    }
    for (const s of submissions) {
      const lesson = s.assignment.lesson;
      push(lesson.unit.course.id, lesson.unit.course.title, {
        id: s.id,
        kind: 'ASSIGNMENT',
        studentName: s.student.user.fullName,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        unitTitle: lesson.unit.title,
        submittedAt: s.createdAt,
      });
    }

    // Oldest waiting first: the student who has been waiting longest is the one
    // with the most reason to have given up on an answer coming.
    return [...courses.values()]
      .map((c) => ({
        ...c,
        items: c.items.sort((x, y) => (x.submittedAt?.getTime() ?? 0) - (y.submittedAt?.getTime() ?? 0)),
        pending: c.items.length,
      }))
      .sort((a, b) => b.pending - a.pending);
  }

  /**
   * One attempt, with everything needed to mark it on one screen: the question,
   * what the teacher said a good answer looks like, what the student actually
   * wrote, what it is out of, and what the AI marker made of it if it ran.
   *
   * Only the questions a machine cannot mark are returned — the rest are
   * already scored and are not a decision anyone has to make.
   */
  async quizAttempt(tenantId: string, attemptId: string) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      where: {
        id: attemptId,
        quiz: { lesson: { unit: { course: { tenantId } } } },
      },
      select: {
        id: true,
        answers: true,
        aiFeedback: true,
        submittedAt: true,
        gradedAt: true,
        scorePct: true,
        student: { select: { user: { select: { fullName: true } } } },
        quiz: {
          select: {
            passingScore: true,
            questions: {
              orderBy: { sortOrder: 'asc' },
              select: { id: true, type: true, prompt: true, modelAnswer: true, points: true },
            },
            lesson: {
              select: {
                id: true, title: true,
                unit: { select: { title: true, course: { select: { id: true, title: true } } } },
              },
            },
          },
        },
      },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');

    const answers = (attempt.answers ?? {}) as Record<string, string>;
    const feedback = (attempt.aiFeedback ?? {}) as Record<string, { similarityPct?: number; reason?: string }>;
    const lesson = attempt.quiz.lesson;
    return {
      id: attempt.id,
      kind: 'QUIZ' as const,
      studentName: attempt.student.user.fullName,
      submittedAt: attempt.submittedAt,
      gradedAt: attempt.gradedAt,
      scorePct: attempt.scorePct,
      passingScore: attempt.quiz.passingScore,
      courseId: lesson.unit.course.id,
      courseTitle: lesson.unit.course.title,
      unitTitle: lesson.unit.title,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      questions: attempt.quiz.questions
        .filter((q) => q.type === 'SHORT_ANSWER')
        .map((q) => ({
          id: q.id,
          prompt: q.prompt,
          modelAnswer: q.modelAnswer,
          points: q.points,
          answer: answers[q.id] ?? '',
          ai: feedback[q.id] ?? null,
        })),
    };
  }

  /** One assignment submission, the same idea with a single body of work. */
  async submission(tenantId: string, submissionId: string) {
    const sub = await this.prisma.assignmentSubmission.findFirst({
      where: { id: submissionId, assignment: { lesson: { unit: { course: { tenantId } } } } },
      select: {
        id: true,
        body: true,
        fileKey: true,
        score: true,
        feedback: true,
        gradedAt: true,
        createdAt: true,
        student: { select: { user: { select: { fullName: true } } } },
        assignment: {
          select: {
            prompt: true,
            maxScore: true,
            lesson: {
              select: {
                id: true, title: true,
                unit: { select: { title: true, course: { select: { id: true, title: true } } } },
              },
            },
          },
        },
      },
    });
    if (!sub) throw new NotFoundException('Submission not found');
    const lesson = sub.assignment.lesson;
    return {
      id: sub.id,
      kind: 'ASSIGNMENT' as const,
      studentName: sub.student.user.fullName,
      submittedAt: sub.createdAt,
      gradedAt: sub.gradedAt,
      score: sub.score,
      feedback: sub.feedback,
      prompt: sub.assignment.prompt,
      maxScore: sub.assignment.maxScore,
      body: sub.body,
      hasFile: !!sub.fileKey,
      courseId: lesson.unit.course.id,
      courseTitle: lesson.unit.course.title,
      unitTitle: lesson.unit.title,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
    };
  }
}
