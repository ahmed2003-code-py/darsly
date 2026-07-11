import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LessonAccessService } from './lesson-access.service';
import { CertificatesService } from './certificates.service';
import {
  GradeAttemptDto,
  SetQuizQuestionsDto,
  SubmitAttemptDto,
  UpsertQuizDto,
} from './dto/quiz.dto';

@Injectable()
export class QuizzesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LessonAccessService,
    private readonly notifications: NotificationsService,
    private readonly certificates: CertificatesService,
  ) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  /** Create or update the quiz attached to one of the teacher's lessons. */
  async upsertForTeacher(tenantId: string, lessonId: string, dto: UpsertQuizDto) {
    await this.access.requireTeacherLesson(tenantId, lessonId);
    // A quiz lesson should be typed QUIZ so the player renders the quiz UI.
    await this.prisma.lesson.update({ where: { id: lessonId }, data: { type: 'QUIZ' } });
    return this.prisma.quiz.upsert({
      where: { lessonId },
      create: {
        lessonId,
        passingScore: dto.passingScore ?? 50,
        timeLimitSec: dto.timeLimitSec ?? null,
        shuffleQuestions: dto.shuffleQuestions ?? false,
      },
      update: {
        ...(dto.passingScore != null ? { passingScore: dto.passingScore } : {}),
        ...(dto.timeLimitSec !== undefined ? { timeLimitSec: dto.timeLimitSec } : {}),
        ...(dto.shuffleQuestions != null ? { shuffleQuestions: dto.shuffleQuestions } : {}),
      },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /** Replace the full question set (builder saves the whole list at once). */
  async setQuestions(tenantId: string, lessonId: string, dto: SetQuizQuestionsDto) {
    const quiz = await this.assertTeacherQuiz(tenantId, lessonId);
    await this.prisma.$transaction([
      this.prisma.quizQuestion.deleteMany({ where: { quizId: quiz.id } }),
      ...dto.questions.map((q, i) =>
        this.prisma.quizQuestion.create({
          data: {
            quizId: quiz.id,
            type: (q.type as any) ?? 'MCQ',
            prompt: q.prompt,
            options: (q.options ?? []) as any,
            correctOptionId: q.correctOptionId ?? null,
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
      where: { id: attemptId, quiz: { lesson: { unit: { course: { tenantId } } } } },
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
      } else if (answers[q.id] != null && answers[q.id] === q.correctOptionId) {
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
    return updated;
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

    const lastAttempt = await this.prisma.quizAttempt.findFirst({
      where: { quizId: quiz.id, studentId },
      orderBy: { startedAt: 'desc' },
    });

    return {
      id: quiz.id,
      passingScore: quiz.passingScore,
      timeLimitSec: quiz.timeLimitSec,
      questions: quiz.questions.map((q) => ({
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

    let earned = 0;
    let total = 0;
    let needsManual = false;
    for (const q of quiz.questions) {
      total += q.points;
      if (q.type === 'SHORT_ANSWER') {
        needsManual = true; // graded later by the teacher
      } else if (dto.answers[q.id] != null && dto.answers[q.id] === q.correctOptionId) {
        earned += q.points;
      }
    }

    const autoPct = total ? Math.round((earned / total) * 100) : 0;
    const scorePct = needsManual ? null : autoPct;
    const passed = needsManual ? null : autoPct >= quiz.passingScore;

    const attempt = await this.prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        studentId,
        answers: dto.answers as any,
        scorePct,
        passed,
        needsManualGrading: needsManual,
        submittedAt: new Date(),
        gradedAt: needsManual ? null : new Date(),
      },
    });

    if (passed) await this.markLessonComplete(studentId, lessonId);

    // Reveal correct answers + explanations only after submitting.
    return {
      attemptId: attempt.id,
      scorePct,
      passed,
      needsManualGrading: needsManual,
      passingScore: quiz.passingScore,
      review: quiz.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        type: q.type,
        correctOptionId: q.correctOptionId,
        explanation: q.explanation,
        yourAnswer: dto.answers[q.id] ?? null,
        correct:
          q.type === 'SHORT_ANSWER'
            ? null
            : dto.answers[q.id] != null && dto.answers[q.id] === q.correctOptionId,
      })),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

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
  }
}
