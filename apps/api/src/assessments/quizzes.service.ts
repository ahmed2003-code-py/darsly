import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AiGraderService } from './ai-grader.service';
import { LessonAccessService } from './lesson-access.service';
import { CertificatesService } from './certificates.service';
import { GamificationService } from '../gamification/gamification.service';
import { GamificationOutcome } from '../gamification/gamification.types';
import {
  GradeAttemptDto,
  SetQuizQuestionsDto,
  SubmitAttemptDto,
  UpsertQuizDto,
} from './dto/quiz.dto';

/**
 * Was this answer right?
 *
 * A question can have more than one right option, and then naming some of them
 * is not the same as naming them — partial credit on a "choose two" turns it
 * into two easier questions. So the sets have to match exactly.
 *
 * `correctOptionIds` is what is read; `correctOptionId` is the fallback for any
 * row written before the column existed.
 */
export function isCorrectAnswer(
  q: { type: string; correctOptionId: string | null; correctOptionIds?: string[] },
  answer: unknown,
): boolean {
  if (q.type === 'SHORT_ANSWER') return false;
  const key = q.correctOptionIds?.length
    ? q.correctOptionIds
    : q.correctOptionId != null
      ? [q.correctOptionId]
      : [];
  if (!key.length) return false;
  const given = Array.isArray(answer) ? answer : answer != null ? [answer] : [];
  const chosen = new Set(given.filter((v): v is string => typeof v === 'string'));
  return chosen.size === key.length && key.every((k) => chosen.has(k));
}

  @Injectable()
export class QuizzesService {
  /** Slack allowed for the trip to the server on a paper sent at the buzzer. */
  private static readonly GRACE_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LessonAccessService,
    private readonly notifications: NotificationsService,
    private readonly certificates: CertificatesService,
    private readonly gamification: GamificationService,
    private readonly aiGrader: AiGraderService,
  ) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  /** Create or update the quiz attached to one of the teacher's lessons. */
  async upsertForTeacher(tenantId: string, lessonId: string, dto: UpsertQuizDto) {
    const own = await this.access.requireTeacherLesson(tenantId, lessonId);
    // A quiz lesson should be typed QUIZ so the player renders the quiz UI.
    await this.prisma.lesson.update({ where: { id: lessonId }, data: { type: 'QUIZ' } });

    // The remedial lesson has to be a video in the same course. Anything else
    // would either send a failing student nowhere or, worse, somewhere they are
    // not entitled to be — and this is the one lesson the exam gate lets past.
    if (dto.remedialLessonId) {
      const ok = await this.prisma.lesson.findFirst({
        where: {
          id: dto.remedialLessonId,
          deletedAt: null,
          type: 'VIDEO',
          unit: { courseId: own.unit.courseId },
        },
        select: { id: true },
      });
      if (!ok) {
        throw new BadRequestException({
          message: 'The remedial lesson must be a video in this course',
          code: 'BAD_REMEDIAL_LESSON',
        });
      }
    }
    // Turning automatic marking on is refused while any written question still
    // has no key to mark against — see assertModelAnswers.
    if (dto.aiGrading === true) await this.assertModelAnswers(lessonId);

    return this.prisma.quiz.upsert({
      where: { lessonId },
      create: {
        lessonId,
        passingScore: dto.passingScore ?? 50,
        timeLimitSec: dto.timeLimitSec ?? null,
        shuffleQuestions: dto.shuffleQuestions ?? false,
        maxAttempts: dto.maxAttempts ?? null,
        remedialLessonId: dto.remedialLessonId ?? null,
        aiGrading: dto.aiGrading ?? false,
        aiThresholdPct: dto.aiThresholdPct ?? 60,
      },
      update: {
        ...(dto.passingScore != null ? { passingScore: dto.passingScore } : {}),
        ...(dto.timeLimitSec !== undefined ? { timeLimitSec: dto.timeLimitSec } : {}),
        ...(dto.shuffleQuestions != null ? { shuffleQuestions: dto.shuffleQuestions } : {}),
        ...(dto.maxAttempts !== undefined ? { maxAttempts: dto.maxAttempts } : {}),
        ...(dto.remedialLessonId !== undefined ? { remedialLessonId: dto.remedialLessonId || null } : {}),
        ...(dto.aiGrading != null ? { aiGrading: dto.aiGrading } : {}),
        ...(dto.aiThresholdPct != null ? { aiThresholdPct: dto.aiThresholdPct } : {}),
      },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /** Replace the full question set (builder saves the whole list at once). */
  async setQuestions(tenantId: string, lessonId: string, dto: SetQuizQuestionsDto) {
    const quiz = await this.assertTeacherQuiz(tenantId, lessonId);

    // The same rule as switching automatic marking on, approached from the
    // other side: a paper already being marked automatically cannot take on a
    // written question with no model answer. Checked against what is about to
    // be saved rather than what is stored, because this call is the change.
    // What automatic marking will be once this edit lands, not what it is now.
    if (dto.aiGrading ?? quiz.aiGrading) {
      const missing = dto.questions.filter(
        (q) => (q.type ?? 'MCQ') === 'SHORT_ANSWER' && !(q.modelAnswer ?? '').trim(),
      );
      if (missing.length) {
        throw new BadRequestException({
          message: 'Every written question needs a model answer while automatic marking is on',
          code: 'MODEL_ANSWER_REQUIRED',
          prompts: missing.map((q) => q.prompt.slice(0, 120)),
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.quizQuestion.deleteMany({ where: { quizId: quiz.id } }),
      ...dto.questions.map((q, i) =>
        this.prisma.quizQuestion.create({
          data: {
            quizId: quiz.id,
            type: (q.type as any) ?? 'MCQ',
            prompt: q.prompt,
            options: (q.options ?? []) as any,
            // Both are written: the array is what grading reads, and the
            // single id keeps any not-yet-deployed code correct.
            correctOptionIds: q.correctOptionIds ?? (q.correctOptionId ? [q.correctOptionId] : []),
            correctOptionId: q.correctOptionIds?.[0] ?? q.correctOptionId ?? null,
            maxSelections: Math.max(1, Math.min(q.maxSelections ?? 1, (q.options ?? []).length || 1)),
            modelAnswer: q.modelAnswer ?? '',
            explanation: q.explanation ?? '',
            points: q.points ?? 1,
            sortOrder: i,
          },
        }),
      ),
    ]);
    return this.getForTeacher(tenantId, lessonId);
  }

  async getForTeacher(tenantId: string, lessonId: string) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    const quiz = await this.prisma.quiz.findUnique({
      where: { lessonId },
      include: {
        questions: { orderBy: { sortOrder: 'asc' } },
        attempts: {
          where: { voidedAt: null },
          orderBy: { submittedAt: 'desc' },
          include: { student: { select: { user: { select: { fullName: true } } } } },
        },
      },
    });
    if (!quiz) return null;
    const pendingGrading = quiz.attempts.filter((a) => a.needsManualGrading).length;
    return { ...quiz, pendingGrading };
  }

  /** Teacher awards points for short-answer questions and finalizes the score. */
  async gradeAttempt(tenantId: string, gradedByUserId: string, attemptId: string, dto: GradeAttemptDto) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      // A voided attempt is one this teacher already handed back. Marking it
      // would put a score and a pass back on a sitting that no longer counts.
      where: { id: attemptId, voidedAt: null, quiz: { lesson: { unit: { course: { tenantId } } } } },
      include: { quiz: { include: { questions: true, lesson: true } } },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');

    const answers = (attempt.answers ?? {}) as Record<string, string>;
    let earned = 0;
    let total = 0;
    for (const q of attempt.quiz.questions) {
      total += q.points;
      if (q.type === 'SHORT_ANSWER') {
        const awarded = Number(dto.scores?.[q.id] ?? 0);
        earned += Math.max(0, Math.min(q.points, awarded));
      } else if (isCorrectAnswer(q, answers[q.id])) {
        earned += q.points;
      }
    }
    const scorePct = total ? Math.round((earned / total) * 100) : 0;
    const passed = scorePct >= attempt.quiz.passingScore;

    const updated = await this.prisma.quizAttempt.update({
      where: { id: attemptId },
      data: {
        scorePct,
        passed,
        needsManualGrading: false,
        gradedAt: new Date(),
        gradedBy: gradedByUserId,
      },
    });
    await this.notifyGraded(attempt.studentId, attempt.quiz.lesson.title, scorePct, passed);
    if (passed) await this.markLessonComplete(attempt.studentId, attempt.quiz.lessonId);
    await this.awardQuiz({
      studentId: attempt.studentId,
      lessonId: attempt.quiz.lessonId,
      quizId: attempt.quizId,
      attemptId,
      scorePct,
      passed,
    });
    return updated;
  }

  /**
   * Give a student their attempts back on one quiz.
   *
   * `maxAttempts` never locked anyone out for one reason only: no teacher could
   * set it, because it was not in the builder. Putting it there without this
   * would mean a student who used their last attempt on a gated course — a
   * course they paid for — had no way in and nobody who could give them one.
   *
   * Nothing is deleted. The attempts stay exactly where they are, readable by
   * the teacher who is deciding whether to allow another go; they are marked
   * voided, and every count, pass check and open sitting ignores them. The
   * student gets a clean paper, and the record of what they wrote survives.
   */
  async resetAttemptsFor(tenantId: string, lessonId: string, studentId: string) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    const quiz = await this.prisma.quiz.findUnique({ where: { lessonId }, select: { id: true } });
    if (!quiz) throw new NotFoundException('This lesson has no quiz');
    // Scoped to this academy's own students, so a teacher cannot void attempts
    // belonging to somebody else's course by guessing an id.
    const enrolled = await this.prisma.enrollment.findFirst({
      where: { studentId, tenantId },
      select: { id: true },
    });
    if (!enrolled) throw new NotFoundException('Student not found in this academy');

    const { count } = await this.prisma.quizAttempt.updateMany({
      where: { quizId: quiz.id, studentId, voidedAt: null },
      data: { voidedAt: new Date() },
    });

    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (student && count > 0) {
      const lesson = await this.prisma.lesson.findUnique({
        where: { id: lessonId },
        select: { title: true },
      });
      await this.notifications
        .create({
          userId: student.userId,
          type: 'ANNOUNCEMENT',
          title: 'معاك محاولة جديدة 🔄',
          body: `المعلّم رجّعلك محاولاتك في «${lesson?.title ?? 'الاختبار'}» — تقدر تدخله تاني.`,
          meta: { lessonId },
        })
        .catch(() => undefined);
    }
    return { voided: count };
  }

  // ── Student attempts ───────────────────────────────────────────────────────

  /** Quiz as the student sees it — correct answers/explanations stripped. */
  async getForStudent(userId: string, lessonId: string) {
    const { studentId } = await this.access.requireStudentAccess(userId, lessonId);
    const quiz = await this.prisma.quiz.findUnique({
      where: { lessonId },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!quiz) throw new NotFoundException('This lesson has no quiz');

    const [lastAttempt, attemptsUsed] = await Promise.all([
      this.prisma.quizAttempt.findFirst({
        where: { quizId: quiz.id, studentId, voidedAt: null },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.quizAttempt.count({ where: { quizId: quiz.id, studentId, voidedAt: null } }),
    ]);

    // A timed paper starts its clock here, the moment the questions are handed
    // over — which is the only honest place for it. The row it opens is what
    // the deadline is measured against on submission, so the limit survives a
    // reloaded page, a second tab, and a client whose clock is wrong.
    const inFlight = quiz.timeLimitSec != null ? await this.openAttempt(quiz, studentId) : null;

    return {
      id: quiz.id,
      passingScore: quiz.passingScore,
      timeLimitSec: quiz.timeLimitSec,
      /** When this sitting must be in by, from the server's clock. */
      deadlineAt:
        inFlight && quiz.timeLimitSec != null
          ? new Date(inFlight.startedAt.getTime() + quiz.timeLimitSec * 1000)
          : null,
      /** Now, as the server sees it, so the countdown does not trust the device. */
      serverNow: new Date(),
      maxAttempts: quiz.maxAttempts,
      attemptsUsed,
      attemptsRemaining: quiz.maxAttempts != null ? Math.max(0, quiz.maxAttempts - attemptsUsed) : null,
      questions: this.inReadingOrder(quiz.questions, quiz.shuffleQuestions).map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        points: q.points,
      })),
      lastAttempt: lastAttempt
        ? {
            id: lastAttempt.id,
            scorePct: lastAttempt.scorePct,
            passed: lastAttempt.passed,
            needsManualGrading: lastAttempt.needsManualGrading,
            submittedAt: lastAttempt.submittedAt,
          }
        : null,
    };
  }

  async submit(userId: string, lessonId: string, dto: SubmitAttemptDto) {
    const { studentId } = await this.access.requireStudentAccess(userId, lessonId);
    const quiz = await this.prisma.quiz.findUnique({
      where: { lessonId },
      include: { questions: true },
    });
    if (!quiz) throw new NotFoundException('This lesson has no quiz');
    if (!quiz.questions.length) throw new BadRequestException('Quiz has no questions yet');

    // Anti-gaming: you can't keep resubmitting to harvest the answer key. Once
    // you pass, or your attempts are used up, submission is closed.
    const [priorCount, passedBefore, sitting] = await Promise.all([
      // Voided attempts are the ones the teacher handed back, so they count
      // for nothing here — see resetAttemptsFor.
      this.prisma.quizAttempt.count({
        where: { quizId: quiz.id, studentId, voidedAt: null, submittedAt: { not: null } },
      }),
      this.prisma.quizAttempt.findFirst({
        where: { quizId: quiz.id, studentId, passed: true, voidedAt: null },
        select: { id: true },
      }),
      // The open sitting for a timed paper, whose clock started when the
      // questions were handed over.
      quiz.timeLimitSec != null
        ? this.prisma.quizAttempt.findFirst({
            where: { quizId: quiz.id, studentId, submittedAt: null, voidedAt: null },
            orderBy: { startedAt: 'desc' },
            select: { id: true, startedAt: true },
          })
        : Promise.resolve(null),
    ]);
    if (passedBefore) {
      throw new BadRequestException({ message: 'You have already passed this quiz', code: 'ALREADY_PASSED' });
    }
    if (quiz.maxAttempts != null && priorCount >= quiz.maxAttempts) {
      throw new BadRequestException({ message: 'No attempts remaining for this quiz', code: 'NO_ATTEMPTS_LEFT' });
    }

    /**
     * Time up.
     *
     * Closed as a sat-and-failed attempt rather than thrown away: the student
     * did sit the paper, so it costs them the attempt, and a refusal that left
     * no record would let the same sitting be retried until the answers were
     * right. The client's countdown submits at zero, so arriving here means the
     * page was left open — or someone tried to take longer than they had.
     */
    if (sitting && this.isOverdue(sitting.startedAt, quiz.timeLimitSec)) {
      await this.prisma.quizAttempt.update({
        where: { id: sitting.id },
        data: { submittedAt: new Date(), scorePct: 0, passed: false, needsManualGrading: false, gradedAt: new Date() },
      });
      throw new BadRequestException({
        message: 'Time is up for this attempt',
        code: 'QUIZ_TIME_UP',
        timeLimitSec: quiz.timeLimitSec,
      });
    }

    /**
     * The written answers, marked against the teacher's model answer.
     *
     * Asked once for the whole paper, before the loop, and it never throws: a
     * question it could not judge is simply absent from the map and falls
     * through to the teacher's queue below — which is what every written
     * question did before this existed. So an outage costs a student nothing
     * but a wait.
     */
    const aiVerdicts = quiz.aiGrading
      ? await this.aiGrader.mark(
          quiz.questions
            .filter((q) => q.type === 'SHORT_ANSWER')
            .map((q) => ({
              questionId: q.id,
              prompt: q.prompt,
              modelAnswer: q.modelAnswer,
              studentAnswer: String(dto.answers[q.id] ?? ''),
            })),
        )
      : new Map();

    let earned = 0;
    let total = 0;
    let pending = 0; // points on questions only a person can mark
    let needsManual = false;
    const aiFeedback: Record<string, { similarityPct: number; reason: string; awarded: boolean }> = {};
    for (const q of quiz.questions) {
      total += q.points;
      if (q.type === 'SHORT_ANSWER') {
        const verdict = aiVerdicts.get(q.id);
        const blank = !String(dto.answers[q.id] ?? '').trim();
        if (verdict) {
          // At or above the threshold the question is full marks, below it is
          // zero. Deliberately binary: a percentage of a percentage reads as a
          // precision the marker does not have.
          const awarded = verdict.similarityPct >= quiz.aiThresholdPct;
          if (awarded) earned += q.points;
          aiFeedback[q.id] = { ...verdict, awarded };
        } else if (quiz.aiGrading && blank) {
          // Nothing written is nothing to mark, and it does not need a model to
          // score zero or a teacher to confirm it.
          aiFeedback[q.id] = { similarityPct: 0, reason: 'لم تُكتب إجابة', awarded: false };
        } else {
          needsManual = true; // graded later by the teacher
          pending += q.points;
        }
      } else if (isCorrectAnswer(q, dto.answers[q.id])) {
        earned += q.points;
      }
    }

    /**
     * Mark what can be marked now.
     *
     * One essay used to put the whole paper in a queue, so a student who got
     * every multiple-choice question right was told "awaiting grading" and
     * learned nothing. The machine knows the answers to the questions it set;
     * it should say so.
     *
     * The verdict follows from the two ends of what is still possible: with the
     * objective part alone already past the pass mark the student has passed,
     * and with every remaining point still not enough they have not. Only the
     * gap between those is genuinely waiting on a person.
     */
    const autoPct = total ? Math.round((earned / total) * 100) : 0;
    const bestPct = total ? Math.round(((earned + pending) / total) * 100) : 0;
    const decided = !needsManual || autoPct >= quiz.passingScore || bestPct < quiz.passingScore;
    const scorePct = autoPct;
    const passed = decided ? autoPct >= quiz.passingScore : null;

    const record = {
      answers: dto.answers as any,
      scorePct,
      passed,
      needsManualGrading: needsManual,
      submittedAt: new Date(),
      // Marked now only when nothing is left for a person to read. A decided
      // result with essays outstanding is still a partial score.
      gradedAt: needsManual ? null : new Date(),
      aiFeedback: Object.keys(aiFeedback).length ? (aiFeedback as any) : undefined,
    };
    // A timed paper already has its row — the one whose clock has been running
    // since the questions were handed over. Creating a second one here would
    // spend two attempts on one sitting and leave the first open forever.
    const attempt = sitting
      ? await this.prisma.quizAttempt.update({ where: { id: sitting.id }, data: record })
      : await this.prisma.quizAttempt.create({ data: { quizId: quiz.id, studentId, ...record } });

    if (passed) await this.markLessonComplete(studentId, lessonId);

    // Points for the work, before the result is assembled — the response
    // carries them so the result screen can show what the attempt earned.
    // Rewarded once the verdict is real, which is now the common case even
    // with an essay on the paper.
    const gamification =
      passed == null
        ? undefined
        : await this.awardQuiz({ studentId, lessonId, quizId: quiz.id, attemptId: attempt.id, scorePct: autoPct, passed });

    // Only reveal the answer key once the student has passed or exhausted their
    // attempts — otherwise a failed attempt would hand out every correct answer
    // to be replayed on the next submission.
    const attemptNumber = priorCount + 1;
    const attemptsExhausted = quiz.maxAttempts != null && attemptNumber >= quiz.maxAttempts;
    const reveal = passed === true || attemptsExhausted;
    const attemptsRemaining = quiz.maxAttempts != null ? Math.max(0, quiz.maxAttempts - attemptNumber) : null;

    return {
      attemptId: attempt.id,
      scorePct,
      passed,
      gamification,
      needsManualGrading: needsManual,
      /**
       * What the automatic marker made of each written answer, so the result
       * screen can show a reason rather than a bare score the student cannot
       * argue with. The teacher can still regrade any of it.
       */
      aiFeedback: Object.keys(aiFeedback).length ? aiFeedback : null,
      /** Points still with a person. Shown so a partial score reads as partial. */
      pendingPoints: pending,
      totalPoints: total,
      passingScore: quiz.passingScore,
      revealed: reveal,
      attemptsRemaining,
      review: reveal
        ? quiz.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            type: q.type,
            correctOptionId: q.correctOptionId,
            correctOptionIds: q.correctOptionIds?.length
              ? q.correctOptionIds
              : q.correctOptionId != null
                ? [q.correctOptionId]
                : [],
            modelAnswer: q.modelAnswer,
            explanation: q.explanation,
            yourAnswer: dto.answers[q.id] ?? null,
            correct: q.type === 'SHORT_ANSWER' ? null : isCorrectAnswer(q, dto.answers[q.id]),
          }))
        : [],
    };
  }

// ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The order the student reads the questions in.
   *
   * `shuffleQuestions` was stored and never read, so every student always got
   * the same order and the setting was decoration. Reshuffled per request
   * rather than fixed per student: answers are keyed by question id, so the
   * order carries no meaning to anything except the person reading it.
   */
  private inReadingOrder<T>(questions: T[], shuffle: boolean): T[] {
    if (!shuffle || questions.length < 2) return questions;
    const out = [...questions];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * The sitting a timed paper's deadline is measured from.
   *
   * Opened when the questions are handed over and reused until it is submitted,
   * so reloading the page or opening a second tab does not buy more time. It
   * counts against `maxAttempts` from the moment it opens — on a timed paper,
   * having seen the questions is the thing being limited.
   *
   * An abandoned sitting is not reused once its own time is up: that attempt is
   * spent, and the next call opens a fresh one (if they have one left, which
   * `submit` and `getForStudent` check).
   */
  private async openAttempt(
    quiz: { id: string; timeLimitSec: number | null },
    studentId: string,
  ): Promise<{ id: string; startedAt: Date }> {
    const open = await this.prisma.quizAttempt.findFirst({
      where: { quizId: quiz.id, studentId, submittedAt: null, voidedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    });
    if (open && !this.isOverdue(open.startedAt, quiz.timeLimitSec)) return open;
    return this.prisma.quizAttempt.create({
      data: { quizId: quiz.id, studentId, startedAt: new Date() },
      select: { id: true, startedAt: true },
    });
  }

  /**
   * Whether a sitting started at `startedAt` is past its deadline.
   *
   * The grace is for the journey, not for the student: a paper sent on the last
   * second still has to cross a network, and losing it to that would be the
   * platform's fault rather than theirs. The client's countdown submits at zero,
   * so this is the backstop and not the normal path.
   */
  private isOverdue(startedAt: Date, timeLimitSec: number | null): boolean {
    if (timeLimitSec == null) return false;
    return Date.now() > startedAt.getTime() + timeLimitSec * 1000 + QuizzesService.GRACE_MS;
  }

  /**
   * Refuse automatic marking on a paper that gives it nothing to mark against.
   *
   * A written question with no model answer has no key, so it would fall
   * through to the teacher's queue — while the teacher, having switched
   * automatic marking on, believes it is being handled. Silently doing half the
   * job is worse than refusing: the questions are named so the teacher knows
   * which ones to go and fill in.
   */
  private async assertModelAnswers(lessonId: string) {
    const written = await this.prisma.quizQuestion.findMany({
      where: { quiz: { lessonId }, type: 'SHORT_ANSWER' },
      select: { prompt: true, modelAnswer: true },
    });
    // Trimmed in code rather than in the query: a model answer of three spaces
    // is not a model answer, and the database cannot see the difference.
    const missing = written.filter((q) => !q.modelAnswer.trim());
    if (!missing.length) return;
    throw new BadRequestException({
      message: 'Every written question needs a model answer before it can be marked automatically',
      code: 'MODEL_ANSWER_REQUIRED',
      prompts: missing.map((q) => q.prompt.slice(0, 120)),
    });
  }

  private async assertTeacherQuiz(tenantId: string, lessonId: string) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    const quiz = await this.prisma.quiz.findUnique({ where: { lessonId } });
    if (!quiz) throw new NotFoundException('Create the quiz before adding questions');
    return quiz;
  }

  private async notifyGraded(studentId: string, lessonTitle: string, scorePct: number, passed: boolean) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (!student) return;
    await this.notifications.create({
      userId: student.userId,
      type: 'QUIZ_GRADED',
      title: passed ? 'تم تصحيح اختبارك — ناجح ✅' : 'تم تصحيح اختبارك',
      body: `«${lessonTitle}»: نتيجتك ${scorePct}%${passed ? ' — مبروك!' : ''}`,
      meta: { scorePct, passed },
    });
  }

  private async markLessonComplete(studentId: string, lessonId: string) {
    await this.prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId, lessonId } },
      create: { studentId, lessonId, watchedPct: 100, completedAt: new Date() },
      update: { watchedPct: 100, completedAt: new Date() },
    });
    await this.certificates.checkByLesson(studentId, lessonId);
    const scope = await this.scopeOf(lessonId);
    await this.gamification.record({
      studentId,
      type: 'LESSON_COMPLETED',
      key: `LESSON_COMPLETED:${studentId}:${lessonId}`,
      tenantId: scope?.tenantId,
      courseId: scope?.courseId,
      entityType: 'lesson',
      entityId: lessonId,
    });
    await this.gamification.checkUnitCompletion(studentId, lessonId);
  }

  /** Which academy and course a lesson belongs to — for scoping the award. */
  private async scopeOf(lessonId: string): Promise<{ tenantId: string; courseId: string } | null> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { unit: { select: { courseId: true, course: { select: { tenantId: true } } } } },
    });
    return lesson ? { tenantId: lesson.unit.course.tenantId, courseId: lesson.unit.courseId } : null;
  }

  /**
   * What an attempt earns.
   *
   * Three separate events, deliberately: finishing a quiz is worth something
   * every time (capped daily, so a student cannot sit the same quiz twenty
   * times for points), while passing it and acing it are worth something *once*
   * — keyed on the quiz, not the attempt.
   */
  private async awardQuiz(input: {
    studentId: string;
    lessonId: string;
    quizId: string;
    attemptId: string;
    scorePct: number;
    passed: boolean;
  }): Promise<GamificationOutcome | undefined> {
    const scope = await this.scopeOf(input.lessonId);
    const base = {
      studentId: input.studentId,
      tenantId: scope?.tenantId,
      courseId: scope?.courseId,
      entityType: 'quiz',
    };
    let last = await this.gamification.record({
      ...base,
      type: 'QUIZ_COMPLETED',
      key: `QUIZ_COMPLETED:${input.studentId}:${input.attemptId}`,
      entityId: input.attemptId,
      meta: { scorePct: input.scorePct, quizId: input.quizId },
    });
    if (input.passed) {
      const passedOutcome = await this.gamification.record({
        ...base,
        type: 'QUIZ_PASSED',
        key: `QUIZ_PASSED:${input.studentId}:${input.quizId}`,
        entityId: input.quizId,
        meta: { scorePct: input.scorePct },
      });
      if (passedOutcome.awarded) last = this.merge(last, passedOutcome);
    }
    if (input.scorePct >= 100) {
      const perfect = await this.gamification.record({
        ...base,
        type: 'QUIZ_PERFECT',
        key: `QUIZ_PERFECT:${input.studentId}:${input.quizId}`,
        entityId: input.quizId,
      });
      if (perfect.awarded) last = this.merge(last, perfect);
    }
    return last.awarded ? last : undefined;
  }

  /** Fold several awards from one submission into a single thing to celebrate. */
  private merge(a: GamificationOutcome, b: GamificationOutcome): GamificationOutcome {
    return {
      awarded: a.awarded || b.awarded,
      xp: a.xp + b.xp,
      coins: a.coins + b.coins,
      totalXp: Math.max(a.totalXp, b.totalXp),
      level: Math.max(a.level, b.level),
      leveledUp: a.leveledUp || b.leveledUp,
      levelNameAr: b.levelNameAr ?? a.levelNameAr,
      levelNameEn: b.levelNameEn ?? a.levelNameEn,
      achievements: [...a.achievements, ...b.achievements],
      missions: [...a.missions, ...b.missions],
    };
  }
}
