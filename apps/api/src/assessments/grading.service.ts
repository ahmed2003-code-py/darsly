import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { isCorrectAnswer } from './quizzes.service';

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
/**
 * How a paper reads once everyone has sat it, and what to do when it is wrong.
 *
 * A key is typed in by hand, so a key is sometimes typed in wrong. The people
 * who find out are the students who answered correctly and were marked down for
 * it, and until now the only signal was a question every single student got
 * wrong — which nobody was looking at, because there was no screen that showed
 * it.
 */
export interface QuestionStat {
  id: string;
  prompt: string;
  points: number;
  options: { id: string; text: string }[];
  correctOptionIds: string[];
  answered: number;
  correct: number;
  /** Share who got it right, of those who answered. */
  correctPct: number;
  /** How many chose each option, so a wrong key stands out as a crowd. */
  byOption: Record<string, number>;
  openReports: number;
  reports: { id: string; studentName: string; note: string; status: string; createdAt: Date }[];
}

@Injectable()
export class GradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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

  /**
   * Which papers have been sat, and where the trouble is.
   *
   * Grouped by course like the marking queue, because a teacher thinks in
   * courses. `openReports` is what makes this worth opening: it is the only
   * place a student's "this question is wrong" surfaces at all.
   */
  async analysis(tenantId: string) {
    const quizzes = await this.prisma.quiz.findMany({
      where: { lesson: { deletedAt: null, unit: { course: { tenantId, deletedAt: null } } } },
      select: {
        id: true,
        lessonId: true,
        lesson: {
          select: {
            title: true,
            unit: { select: { title: true, course: { select: { id: true, title: true } } } },
          },
        },
        questions: { select: { id: true } },
        attempts: {
          where: { voidedAt: null, submittedAt: { not: null } },
          select: { scorePct: true, needsManualGrading: true },
        },
      },
    });

    const reportCounts = await this.prisma.questionReport.groupBy({
      by: ['questionId'],
      where: { status: 'OPEN', question: { quiz: { lesson: { unit: { course: { tenantId } } } } } },
      _count: true,
    });
    const openByQuestion = new Map(reportCounts.map((r) => [r.questionId, r._count]));

    // Assignments sit beside the papers but are counted separately: an exam and
    // a piece of written work are not the same thing to a teacher, and a single
    // mixed list was the first thing that made this screen hard to read.
    const assignments = await this.prisma.assignment.findMany({
      where: { lesson: { deletedAt: null, unit: { course: { tenantId, deletedAt: null } } } },
      select: {
        lessonId: true,
        maxScore: true,
        lesson: {
          select: {
            title: true,
            unit: { select: { title: true, course: { select: { id: true, title: true } } } },
          },
        },
        submissions: { select: { score: true, gradedAt: true } },
      },
    });

    const courses = new Map<
      string,
      { courseId: string; courseTitle: string; quizzes: unknown[]; assignments: unknown[] }
    >();
    for (const q of quizzes) {
      const scored = q.attempts.filter((a) => !a.needsManualGrading && a.scorePct != null);
      const openReports = q.questions.reduce((n, qq) => n + (openByQuestion.get(qq.id) ?? 0), 0);
      // A paper nobody has sat and nobody has complained about tells a teacher
      // nothing, and a list of those buries the ones that do.
      if (!q.attempts.length && !openReports) continue;
      const course = q.lesson.unit.course;
      const row = courses.get(course.id) ?? {
        courseId: course.id, courseTitle: course.title, quizzes: [], assignments: [],
      };
      row.quizzes.push({
        lessonId: q.lessonId,
        lessonTitle: q.lesson.title,
        unitTitle: q.lesson.unit.title,
        questionCount: q.questions.length,
        attempts: q.attempts.length,
        avgPct: scored.length
          ? Math.round(scored.reduce((n, a) => n + (a.scorePct ?? 0), 0) / scored.length)
          : null,
        openReports,
        pendingGrading: q.attempts.filter((a) => a.needsManualGrading).length,
      });
      courses.set(course.id, row);
    }

    for (const a of assignments) {
      if (!a.submissions.length) continue;
      const course = a.lesson.unit.course;
      const row = courses.get(course.id) ?? {
        courseId: course.id, courseTitle: course.title, quizzes: [], assignments: [],
      };
      const marked = a.submissions.filter((s) => s.gradedAt && s.score != null);
      row.assignments.push({
        lessonId: a.lessonId,
        lessonTitle: a.lesson.title,
        unitTitle: a.lesson.unit.title,
        maxScore: a.maxScore,
        submissions: a.submissions.length,
        avgScore: marked.length
          ? Math.round(marked.reduce((n, s) => n + (s.score ?? 0), 0) / marked.length)
          : null,
        pendingGrading: a.submissions.filter((s) => !s.gradedAt).length,
      });
      courses.set(course.id, row);
    }

    return [...courses.values()];
  }

  /**
   * One paper, question by question: what the class chose, who got it right,
   * and who says it is wrong.
   *
   * `byOption` is the number that does the work. A question where three
   * quarters of the class picked the same wrong option is usually not a class
   * that failed to revise — it is a key with the wrong letter in it.
   */
  async quizAnalysis(tenantId: string, lessonId: string) {
    const quiz = await this.prisma.quiz.findFirst({
      where: { lessonId, lesson: { unit: { course: { tenantId } } } },
      select: {
        id: true,
        lesson: {
          select: {
            title: true,
            unit: { select: { title: true, course: { select: { id: true, title: true } } } },
          },
        },
        questions: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true, type: true, prompt: true, points: true, options: true,
            correctOptionId: true, correctOptionIds: true,
            reports: {
              orderBy: { createdAt: 'desc' },
              select: {
                id: true, note: true, status: true, createdAt: true,
                student: { select: { user: { select: { fullName: true } } } },
              },
            },
          },
        },
        attempts: {
          where: { voidedAt: null, submittedAt: { not: null } },
          select: { answers: true },
        },
      },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');

    const questions: QuestionStat[] = quiz.questions
      .filter((q) => q.type !== 'SHORT_ANSWER')
      .map((q) => {
        const options = (q.options ?? []) as { id: string; text: string }[];
        const key = q.correctOptionIds?.length
          ? q.correctOptionIds
          : q.correctOptionId
            ? [q.correctOptionId]
            : [];
        const byOption: Record<string, number> = Object.fromEntries(options.map((o) => [o.id, 0]));
        let answered = 0;
        let correct = 0;
        for (const a of quiz.attempts) {
          const given = ((a.answers ?? {}) as Record<string, unknown>)[q.id];
          const picked = Array.isArray(given) ? given : given != null ? [given] : [];
          if (!picked.length) continue;
          answered++;
          for (const p of picked) if (typeof p === 'string' && p in byOption) byOption[p]++;
          if (isCorrectAnswer(q, given)) correct++;
        }
        return {
          id: q.id,
          prompt: q.prompt,
          points: q.points,
          options,
          correctOptionIds: key,
          answered,
          correct,
          correctPct: answered ? Math.round((correct / answered) * 100) : 0,
          byOption,
          openReports: q.reports.filter((r) => r.status === 'OPEN').length,
          reports: q.reports.map((r) => ({
            id: r.id,
            studentName: r.student.user.fullName,
            note: r.note,
            status: r.status,
            createdAt: r.createdAt,
          })),
        };
      });

    return {
      lessonId,
      lessonTitle: quiz.lesson.title,
      unitTitle: quiz.lesson.unit.title,
      courseId: quiz.lesson.unit.course.id,
      courseTitle: quiz.lesson.unit.course.title,
      attempts: quiz.attempts.length,
      questions,
    };
  }

  /**
   * Correct the key, and give back the marks it cost.
   *
   * The regrade works on the DIFFERENCE this one question makes, not by
   * re-marking the paper: a mixed paper's written questions were marked by hand
   * and only the final percentage was ever stored, so there is nothing to
   * recompute them from. What this question was worth before and what it is
   * worth now is knowable exactly, and that is what moves.
   *
   * **A correction never lowers anybody's mark.** Students who picked the
   * option the old key called right did nothing wrong; taking their marks away
   * to fix our typo punishes them for it. Students who picked the option that
   * was right all along get what they earned. Papers still waiting to be marked
   * are left alone — they have not been scored yet and will be scored against
   * the new key when they are.
   */
  async fixKey(tenantId: string, userId: string, questionId: string, correctOptionIds: string[]) {
    const question = await this.prisma.quizQuestion.findFirst({
      where: { id: questionId, quiz: { lesson: { unit: { course: { tenantId } } } } },
      select: {
        id: true, type: true, points: true, options: true,
        correctOptionId: true, correctOptionIds: true,
        quiz: {
          select: {
            id: true, passingScore: true, lessonId: true,
            lesson: { select: { title: true } },
            questions: { select: { points: true } },
          },
        },
      },
    });
    if (!question) throw new NotFoundException('Question not found');
    if (question.type === 'SHORT_ANSWER') {
      throw new BadRequestException({
        message: 'A written question has no key to correct',
        code: 'NOT_A_KEYED_QUESTION',
      });
    }

    const options = (question.options ?? []) as { id: string }[];
    const valid = new Set(options.map((o) => o.id));
    const key = [...new Set(correctOptionIds)].filter((id) => valid.has(id));
    if (!key.length) {
      throw new BadRequestException({
        message: 'Name at least one option from this question',
        code: 'BAD_KEY',
      });
    }

    const before = { type: question.type, correctOptionId: question.correctOptionId, correctOptionIds: question.correctOptionIds };
    const after = { type: question.type, correctOptionId: key[0], correctOptionIds: key };
    const total = question.quiz.questions.reduce((n, q) => n + q.points, 0);

    await this.prisma.quizQuestion.update({
      where: { id: questionId },
      data: { correctOptionIds: key, correctOptionId: key[0] },
    });

    // Only papers that already carry a mark: one still waiting to be marked has
    // no score to move, and will meet the corrected key when it is marked.
    const attempts = await this.prisma.quizAttempt.findMany({
      where: {
        quizId: question.quiz.id,
        voidedAt: null,
        submittedAt: { not: null },
        needsManualGrading: false,
        scorePct: { not: null },
      },
      select: { id: true, answers: true, scorePct: true, studentId: true },
    });

    let raised = 0;
    for (const a of attempts) {
      const given = ((a.answers ?? {}) as Record<string, unknown>)[question.id];
      const was = isCorrectAnswer(before, given);
      const now = isCorrectAnswer(after, given);
      if (was === now) continue;
      const delta = (now ? question.points : 0) - (was ? question.points : 0);
      if (delta <= 0 || !total) continue; // never downward — see above
      const next = Math.max(0, Math.min(100, Math.round((a.scorePct ?? 0) + (delta / total) * 100)));
      if (next <= (a.scorePct ?? 0)) continue;
      await this.prisma.quizAttempt.update({
        where: { id: a.id },
        data: { scorePct: next, passed: next >= question.quiz.passingScore },
      });
      raised++;
      await this.notifyRaised(a.studentId, question.quiz.lesson.title, next);
    }

    // The complaint is answered by the fix, so it stops being a complaint.
    const resolved = await this.prisma.questionReport.updateMany({
      where: { questionId, status: 'OPEN' },
      data: { status: 'ACCEPTED', resolvedAt: new Date(), resolvedBy: userId },
    });

    return { ok: true, correctOptionIds: key, regraded: attempts.length, raised, reportsAccepted: resolved.count };
  }

  /** The teacher looked and the question was right after all. */
  async dismissReport(tenantId: string, userId: string, reportId: string) {
    const report = await this.prisma.questionReport.findFirst({
      where: { id: reportId, question: { quiz: { lesson: { unit: { course: { tenantId } } } } } },
      select: { id: true },
    });
    if (!report) throw new NotFoundException('Report not found');
    await this.prisma.questionReport.update({
      where: { id: reportId },
      data: { status: 'DISMISSED', resolvedAt: new Date(), resolvedBy: userId },
    });
    return { ok: true };
  }

  private async notifyRaised(studentId: string, lessonTitle: string, scorePct: number) {
    try {
      const s = await this.prisma.studentProfile.findUnique({
        where: { id: studentId },
        select: { userId: true },
      });
      if (!s) return;
      await this.notifications.create({
        userId: s.userId,
        type: 'ANNOUNCEMENT',
        title: 'اتعدّلت درجتك 📈',
        body: `صحّحنا سؤال في «${lessonTitle}» واترفعت درجتك لـ ${scorePct}%.`,
      });
    } catch {
      // A mark that moved matters; a notification that did not is not worth
      // rolling it back for.
    }
  }


  /**
   * Who sat this paper, and how it went for each of them.
   *
   * The list a teacher actually wants after "how did the class do": names, not
   * an average. Ordered worst first — a teacher scanning this is looking for
   * who needs help, and that person is at the bottom of an alphabetical list.
   */
  async quizStudents(tenantId: string, lessonId: string) {
    const quiz = await this.prisma.quiz.findFirst({
      where: { lessonId, lesson: { unit: { course: { tenantId } } } },
      select: {
        passingScore: true,
        lesson: { select: { title: true, unit: { select: { course: { select: { title: true } } } } } },
        attempts: {
          where: { voidedAt: null, submittedAt: { not: null } },
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true, scorePct: true, passed: true, needsManualGrading: true,
            submittedAt: true, gradedAt: true,
            student: { select: { id: true, user: { select: { fullName: true } } } },
          },
        },
      },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    return {
      lessonId,
      lessonTitle: quiz.lesson.title,
      courseTitle: quiz.lesson.unit.course.title,
      passingScore: quiz.passingScore,
      students: quiz.attempts
        .map((a) => ({
          attemptId: a.id,
          studentId: a.student.id,
          studentName: a.student.user.fullName,
          scorePct: a.scorePct,
          passed: a.passed,
          needsManualGrading: a.needsManualGrading,
          submittedAt: a.submittedAt,
        }))
        // Waiting to be marked first — they are the ones needing a decision —
        // then the lowest marks, because that is who the teacher is looking for.
        .sort((x, y) => {
          if (x.needsManualGrading !== y.needsManualGrading) return x.needsManualGrading ? -1 : 1;
          return (x.scorePct ?? 0) - (y.scorePct ?? 0);
        }),
    };
  }

  /** The same for a written assignment. */
  async assignmentStudents(tenantId: string, lessonId: string) {
    const assignment = await this.prisma.assignment.findFirst({
      where: { lessonId, lesson: { unit: { course: { tenantId } } } },
      select: {
        maxScore: true,
        lesson: { select: { title: true, unit: { select: { course: { select: { title: true } } } } } },
        submissions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, score: true, gradedAt: true, createdAt: true,
            student: { select: { id: true, user: { select: { fullName: true } } } },
          },
        },
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return {
      lessonId,
      lessonTitle: assignment.lesson.title,
      courseTitle: assignment.lesson.unit.course.title,
      maxScore: assignment.maxScore,
      students: assignment.submissions
        .map((s) => ({
          submissionId: s.id,
          studentId: s.student.id,
          studentName: s.student.user.fullName,
          score: s.score,
          needsGrading: !s.gradedAt,
          submittedAt: s.createdAt,
        }))
        .sort((x, y) => {
          if (x.needsGrading !== y.needsGrading) return x.needsGrading ? -1 : 1;
          return (x.score ?? 0) - (y.score ?? 0);
        }),
    };
  }

  /**
   * One student's paper, whole: every question, what they chose, what was
   * right, and whether it counted.
   *
   * Different from `quizAttempt`, which returns only what still needs a
   * decision. This is for reading a finished paper — the question a teacher is
   * answering here is "why did this student get this mark", and that cannot be
   * answered by the questions they were marked on by hand alone.
   */
  async attemptReview(tenantId: string, attemptId: string) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      where: { id: attemptId, quiz: { lesson: { unit: { course: { tenantId } } } } },
      select: {
        id: true, answers: true, aiFeedback: true, manualScores: true, scorePct: true,
        passed: true, submittedAt: true, gradedAt: true, needsManualGrading: true,
        student: { select: { user: { select: { fullName: true } } } },
        quiz: {
          select: {
            passingScore: true,
            lesson: { select: { id: true, title: true, unit: { select: { course: { select: { title: true } } } } } },
            questions: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true, type: true, prompt: true, options: true, points: true,
                correctOptionId: true, correctOptionIds: true, modelAnswer: true, explanation: true,
              },
            },
          },
        },
      },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');

    const answers = (attempt.answers ?? {}) as Record<string, unknown>;
    const ai = (attempt.aiFeedback ?? {}) as Record<
      string,
      { similarityPct?: number; reason?: string; awarded?: boolean }
    >;
    const manual = (attempt.manualScores ?? {}) as Record<string, number>;
    return {
      attemptId: attempt.id,
      studentName: attempt.student.user.fullName,
      scorePct: attempt.scorePct,
      passed: attempt.passed,
      needsManualGrading: attempt.needsManualGrading,
      submittedAt: attempt.submittedAt,
      passingScore: attempt.quiz.passingScore,
      lessonId: attempt.quiz.lesson.id,
      lessonTitle: attempt.quiz.lesson.title,
      courseTitle: attempt.quiz.lesson.unit.course.title,
      questions: attempt.quiz.questions.map((q) => {
        const given = answers[q.id];
        const key = q.correctOptionIds?.length
          ? q.correctOptionIds
          : q.correctOptionId
            ? [q.correctOptionId]
            : [];
        const chosen = Array.isArray(given)
          ? given.filter((v): v is string => typeof v === 'string')
          : typeof given === 'string'
            ? [given]
            : [];
        return {
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          points: q.points,
          options: (q.options ?? []) as { id: string; text: string }[],
          correctOptionIds: key,
          chosenOptionIds: chosen,
          // A written answer is not right or wrong here — a person decided what
          // it was worth, and saying "wrong" about it would be inventing that.
          correct: q.type === 'SHORT_ANSWER' ? null : isCorrectAnswer(q, given),
          writtenAnswer: q.type === 'SHORT_ANSWER' ? (typeof given === 'string' ? given : '') : null,
          /**
           * What a written answer actually earned, and who decided.
           *
           * A mark with no author is a mark nobody can argue with. The two
           * differ in what they are worth as an answer to "why this mark": a
           * teacher's is a judgement, the marker's is a measurement against the
           * model answer, and a student deserves to know which one they got.
           */
          ...(q.type === 'SHORT_ANSWER'
            ? manual[q.id] != null
              ? { awardedPoints: manual[q.id], markedBy: 'TEACHER' as const }
              : ai[q.id]?.awarded != null
                ? { awardedPoints: ai[q.id].awarded ? q.points : 0, markedBy: 'AI' as const }
                : { awardedPoints: null, markedBy: null }
            : { awardedPoints: null, markedBy: null }),
          modelAnswer: q.modelAnswer,
          explanation: q.explanation,
          ai: ai[q.id] ?? null,
        };
      }),
    };
  }

}
