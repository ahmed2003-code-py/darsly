import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProgressService } from '../progress/progress.service';
import { GamificationService } from '../gamification/gamification.service';
import { GamificationOutcome } from '../gamification/gamification.types';
import { isCorrectAnswer } from '../assessments/quizzes.service';
import { ChallengesAccessService } from './challenges-access.service';
import { ChallengeScoringService } from './challenge-scoring.service';
import {
  SetChallengeQuestionsDto,
  SubmitChallengeAnswerDto,
  UpsertChallengeDto,
} from './dto/challenge.dto';

type ChallengeWithQuestions = Prisma.ChallengeGetPayload<{ include: { questions: true } }>;

@Injectable()
export class ChallengesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ChallengesAccessService,
    private readonly scoring: ChallengeScoringService,
    private readonly gamification: GamificationService,
    private readonly progress: ProgressService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Teacher authoring ──────────────────────────────────────────────────────

  /**
   * What a teacher gets without touching a single settings field.
   *
   * A teacher who just picks a type, adds questions and publishes should get
   * a coherent, working challenge — not a half-configured one. Practice reads
   * as low-pressure practice (untimed by default, standard scoring, the key
   * shown right away, several tries); Ranked reads as competitive (timed,
   * speed bonus live, one shot, on the leaderboard) — without asking the
   * teacher to know what "answerReveal" or "randomize" mean. Anything the
   * teacher DID set explicitly always wins; this only fills in what they left
   * out — see UpsertChallengeDto and the builder's collapsed "Advanced" panel.
   */
  private defaultsFor(type: 'PRACTICE' | 'RANKED') {
    return type === 'RANKED'
      ? {
          scoring: 'SPEED_BASED' as const,
          questionTimeSec: 20,
          maxAttempts: 1,
          leaderboardEnabled: true,
          answerReveal: 'AFTER_SUBMISSION' as const,
          randomize: 'QUESTIONS' as const,
        }
      : {
          scoring: 'STANDARD' as const,
          questionTimeSec: null,
          maxAttempts: 3,
          leaderboardEnabled: false,
          answerReveal: 'IMMEDIATE' as const,
          randomize: 'NONE' as const,
        };
  }

  async create(tenantId: string, dto: UpsertChallengeDto) {
    const type = dto.type ?? 'PRACTICE';
    const d = this.defaultsFor(type);
    return this.prisma.challenge.create({
      data: {
        tenantId,
        title: dto.title,
        description: dto.description ?? '',
        coverIcon: dto.coverIcon ?? 'bolt',
        type,
        difficulty: dto.difficulty ?? 1,
        courseId: dto.courseId ?? null,
        subjectId: dto.subjectId ?? null,
        gradeId: dto.gradeId ?? null,
        topic: dto.topic ?? null,
        durationSec: dto.durationSec ?? null,
        questionTimeSec:
          dto.questionTimeSec !== undefined ? dto.questionTimeSec : d.questionTimeSec,
        scoring: dto.scoring ?? d.scoring,
        maxAttempts: dto.maxAttempts ?? d.maxAttempts,
        leaderboardEnabled: dto.leaderboardEnabled ?? d.leaderboardEnabled,
        answerReveal: dto.answerReveal ?? d.answerReveal,
        randomize: dto.randomize ?? d.randomize,
      },
    });
  }

  async update(tenantId: string, challengeId: string, dto: UpsertChallengeDto) {
    const challenge = await this.access.requireTeacherChallenge(tenantId, challengeId);
    // Once students have played it, the settings that decide how an attempt is
    // scored must not move under them — a duration or scoring-mode change
    // after the fact would make an in-flight or already-scored attempt
    // unexplainable. Everything else (title, description, icon) is always safe.
    const hasAttempts = await this.prisma.challengeAttempt.count({ where: { challengeId } });
    if (hasAttempts > 0 && challenge.status !== 'DRAFT') {
      const lockedKeys: (keyof UpsertChallengeDto)[] = [
        'durationSec',
        'questionTimeSec',
        'scoring',
        'maxAttempts',
        'type',
      ];
      const touched = lockedKeys.filter((k) => dto[k] !== undefined);
      if (touched.length) {
        throw new BadRequestException({
          message: 'Cannot change scoring-affecting settings after students have started playing',
          code: 'CHALLENGE_HAS_ATTEMPTS',
          fields: touched,
        });
      }
    }

    return this.prisma.challenge.update({
      where: { id: challengeId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.coverIcon !== undefined ? { coverIcon: dto.coverIcon } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty } : {}),
        ...(dto.courseId !== undefined ? { courseId: dto.courseId } : {}),
        ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
        ...(dto.gradeId !== undefined ? { gradeId: dto.gradeId } : {}),
        ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
        ...(dto.durationSec !== undefined ? { durationSec: dto.durationSec } : {}),
        ...(dto.questionTimeSec !== undefined ? { questionTimeSec: dto.questionTimeSec } : {}),
        ...(dto.scoring !== undefined ? { scoring: dto.scoring } : {}),
        ...(dto.maxAttempts !== undefined ? { maxAttempts: dto.maxAttempts } : {}),
        ...(dto.leaderboardEnabled !== undefined
          ? { leaderboardEnabled: dto.leaderboardEnabled }
          : {}),
        ...(dto.answerReveal !== undefined ? { answerReveal: dto.answerReveal } : {}),
        ...(dto.randomize !== undefined ? { randomize: dto.randomize } : {}),
      },
    });
  }

  async setQuestions(tenantId: string, challengeId: string, dto: SetChallengeQuestionsDto) {
    const challenge = await this.access.requireTeacherChallenge(tenantId, challengeId);
    if (challenge.status !== 'DRAFT') {
      throw new BadRequestException({
        message: 'Unpublish the challenge before editing its questions',
        code: 'CHALLENGE_NOT_DRAFT',
      });
    }

    await this.prisma.$transaction([
      this.prisma.challengeQuestion.deleteMany({ where: { challengeId } }),
      ...dto.questions.map((q, i) =>
        this.prisma.challengeQuestion.create({
          data: {
            challengeId,
            type: q.type ?? 'MCQ',
            prompt: q.prompt,
            imageUrl: q.imageUrl ?? null,
            options: (q.options ?? []) as unknown as Prisma.InputJsonValue,
            correctOptionIds: q.correctOptionIds ?? [],
            explanation: q.explanation ?? '',
            points: q.points ?? 100,
            timeLimitSec: q.timeLimitSec ?? null,
            topic: q.topic ?? null,
            difficulty: q.difficulty ?? 1,
            sortOrder: i,
          },
        }),
      ),
    ]);
    return this.getForTeacher(tenantId, challengeId);
  }

  async getForTeacher(tenantId: string, challengeId: string) {
    await this.access.requireTeacherChallenge(tenantId, challengeId);
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { questions: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');
    const attemptCount = await this.prisma.challengeAttempt.count({ where: { challengeId } });
    return { ...challenge, attemptCount };
  }

  async listForTeacher(tenantId: string, status?: string) {
    const challenges = await this.prisma.challenge.findMany({
      where: { tenantId, deletedAt: null, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { questions: true, attempts: true } } },
    });
    return challenges.map((c) => ({
      ...c,
      questionCount: c._count.questions,
      attemptCount: c._count.attempts,
      _count: undefined,
    }));
  }

  /**
   * Duplicate a challenge and all of its questions as a fresh draft.
   *
   * Nothing about play — attempts, scores, submissions — comes with it. A copy
   * is a new challenge that happens to start from the same questions, not a
   * second window onto the same results.
   */
  async duplicate(tenantId: string, challengeId: string) {
    const source = await this.getForTeacher(tenantId, challengeId);
    const copy = await this.prisma.challenge.create({
      data: {
        tenantId,
        title: `${source.title} (نسخة)`,
        description: source.description,
        coverIcon: source.coverIcon,
        type: source.type,
        difficulty: source.difficulty,
        courseId: source.courseId,
        subjectId: source.subjectId,
        gradeId: source.gradeId,
        topic: source.topic,
        durationSec: source.durationSec,
        questionTimeSec: source.questionTimeSec,
        scoring: source.scoring,
        maxAttempts: source.maxAttempts,
        leaderboardEnabled: source.leaderboardEnabled,
        answerReveal: source.answerReveal,
        randomize: source.randomize,
        status: 'DRAFT',
        questions: {
          create: source.questions.map((q) => ({
            type: q.type,
            prompt: q.prompt,
            imageUrl: q.imageUrl,
            options: q.options as Prisma.InputJsonValue,
            correctOptionIds: q.correctOptionIds,
            explanation: q.explanation,
            points: q.points,
            timeLimitSec: q.timeLimitSec,
            topic: q.topic,
            difficulty: q.difficulty,
            sortOrder: q.sortOrder,
          })),
        },
      },
    });
    return copy;
  }

  /**
   * Validate and publish — the pre-flight §35 asks for: real questions, every
   * one of them has a real answer key, sane settings, nothing malformed.
   * Thrown as one response naming every problem at once, not the first one hit.
   */
  async publish(tenantId: string, challengeId: string) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { id: challengeId, tenantId, deletedAt: null },
      include: { questions: true },
    });
    if (!challenge) throw new NotFoundException('Challenge not found');

    const errors: string[] = [];
    if (!challenge.title.trim()) errors.push('Title is required');
    if (!challenge.questions.length) errors.push('Add at least one question');
    for (const q of challenge.questions) {
      const options = Array.isArray(q.options) ? (q.options as { id: string }[]) : [];
      if (!q.prompt.trim()) errors.push(`Question ${q.sortOrder + 1}: prompt is empty`);
      if (q.type !== 'SHORT_ANSWER' && options.length < 2) {
        errors.push(`Question ${q.sortOrder + 1}: needs at least 2 options`);
      }
      if (q.type !== 'SHORT_ANSWER' && !q.correctOptionIds.length) {
        errors.push(`Question ${q.sortOrder + 1}: no correct answer set`);
      }
      if (q.correctOptionIds.some((id) => !options.some((o) => o.id === id))) {
        errors.push(`Question ${q.sortOrder + 1}: correct answer does not match its options`);
      }
      if (q.points < 1) errors.push(`Question ${q.sortOrder + 1}: points must be positive`);
    }
    if (challenge.scoring === 'SPEED_BASED' && !challenge.questionTimeSec) {
      const anyPerQuestionTimer = challenge.questions.some((q) => q.timeLimitSec != null);
      if (!anyPerQuestionTimer) {
        errors.push('Speed-based scoring needs a question timer (default or per-question)');
      }
    }
    if (errors.length) {
      throw new BadRequestException({
        message: 'Challenge is not ready to publish',
        code: 'CHALLENGE_INVALID',
        errors,
      });
    }

    return this.prisma.challenge.update({
      where: { id: challengeId },
      data: { status: 'PUBLISHED', publishedAt: challenge.publishedAt ?? new Date() },
    });
  }

  async unpublish(tenantId: string, challengeId: string) {
    await this.access.requireTeacherChallenge(tenantId, challengeId);
    return this.prisma.challenge.update({ where: { id: challengeId }, data: { status: 'DRAFT' } });
  }

  async close(tenantId: string, challengeId: string) {
    await this.access.requireTeacherChallenge(tenantId, challengeId);
    return this.prisma.challenge.update({
      where: { id: challengeId },
      data: { status: 'CLOSED', closesAt: new Date() },
    });
  }

  /**
   * Delete where safe, archive otherwise.
   *
   * A challenge nobody has ever played is only a draft occupying a teacher's
   * list — removing it destroys nothing. One with real attempts carries
   * students' XP, coins and results; deleting it would either orphan that
   * history or cascade it away, and neither is acceptable. Archiving keeps
   * every result exactly where it is and simply takes the challenge out of the
   * "create new" list — the same shape as a course's soft delete.
   */
  async remove(tenantId: string, challengeId: string) {
    await this.access.requireTeacherChallenge(tenantId, challengeId);
    const hasAttempts = await this.prisma.challengeAttempt.count({ where: { challengeId } });
    if (hasAttempts > 0) {
      await this.prisma.challenge.update({
        where: { id: challengeId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      return { deleted: false, archived: true };
    }
    await this.prisma.challenge.update({
      where: { id: challengeId },
      data: { deletedAt: new Date() },
    });
    return { deleted: true, archived: false };
  }

  // ── Teacher submissions & analytics ────────────────────────────────────────

  async submissions(tenantId: string, challengeId: string) {
    await this.access.requireTeacherChallenge(tenantId, challengeId);
    const attempts = await this.prisma.challengeAttempt.findMany({
      where: { challengeId, status: { in: ['COMPLETED', 'TIMED_OUT'] } },
      orderBy: { completedAt: 'desc' },
      include: { student: { select: { user: { select: { fullName: true, avatarUrl: true } } } } },
    });
    return attempts.map((a) => ({
      id: a.id,
      studentId: a.studentId,
      studentName: a.student.user.fullName,
      studentAvatarUrl: a.student.user.avatarUrl,
      status: a.status,
      score: a.score,
      accuracyPct: a.accuracyPct,
      speedPct: a.speedPct,
      xpAwarded: a.xpAwarded,
      completedAt: a.completedAt,
      attemptNumber: a.attemptNumber,
    }));
  }

  async analytics(tenantId: string, challengeId: string) {
    const challenge = await this.getForTeacher(tenantId, challengeId);
    const attempts = await this.prisma.challengeAttempt.findMany({
      where: { challengeId, status: { in: ['COMPLETED', 'TIMED_OUT'] } },
      include: { answers: true },
    });

    const participants = new Set(attempts.map((a) => a.studentId)).size;
    const completed = attempts.filter((a) => a.status === 'COMPLETED').length;
    const avg = (nums: number[]) =>
      nums.length ? Math.round(nums.reduce((s, n) => s + n, 0) / nums.length) : 0;

    const perQuestion = new Map<string, { correct: number; total: number }>();
    for (const a of attempts) {
      for (const ans of a.answers) {
        const row = perQuestion.get(ans.questionId) ?? { correct: 0, total: 0 };
        row.total += 1;
        if (ans.isCorrect) row.correct += 1;
        perQuestion.set(ans.questionId, row);
      }
    }
    const questionStats = challenge.questions.map((q) => {
      const row = perQuestion.get(q.id) ?? { correct: 0, total: 0 };
      return {
        questionId: q.id,
        prompt: q.prompt,
        correctPct: row.total ? Math.round((row.correct / row.total) * 100) : null,
        answeredCount: row.total,
      };
    });
    const withStats = questionStats.filter((q) => q.correctPct != null);
    const hardest = withStats.length
      ? withStats.reduce((a, b) => (a.correctPct! < b.correctPct! ? a : b))
      : null;
    const easiest = withStats.length
      ? withStats.reduce((a, b) => (a.correctPct! > b.correctPct! ? a : b))
      : null;

    return {
      participants,
      attemptsStarted: attempts.length,
      completed,
      completionRatePct: attempts.length ? Math.round((completed / attempts.length) * 100) : 0,
      avgScore: avg(attempts.map((a) => a.score)),
      avgAccuracyPct: avg(attempts.map((a) => a.accuracyPct ?? 0)),
      avgSpeedPct: avg(attempts.filter((a) => a.speedPct != null).map((a) => a.speedPct!)),
      avgXp: avg(attempts.map((a) => a.xpAwarded)),
      hardestQuestion: hardest,
      easiestQuestion: easiest,
      questionStats,
    };
  }

  // ── Student browsing ───────────────────────────────────────────────────────

  async listForStudent(
    userId: string,
    tab: 'available' | 'in_progress' | 'completed' = 'available',
  ) {
    const studentId = await this.access.studentIdOf(userId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId, status: 'ACTIVE' },
      select: { course: { select: { tenantId: true, id: true } } },
    });
    const tenantIds = [...new Set(enrollments.map((e) => e.course.tenantId))];
    const courseIds = [...new Set(enrollments.map((e) => e.course.id))];
    if (!tenantIds.length) return [];

    const myAttempts = await this.prisma.challengeAttempt.findMany({
      where: { studentId },
      select: { challengeId: true, status: true, score: true, completedAt: true },
    });
    const byChallenge = new Map<string, typeof myAttempts>();
    for (const a of myAttempts)
      byChallenge.set(a.challengeId, [...(byChallenge.get(a.challengeId) ?? []), a]);

    const challenges = await this.prisma.challenge.findMany({
      where: {
        deletedAt: null,
        status: { in: ['PUBLISHED', 'ACTIVE'] },
        tenantId: { in: tenantIds },
        OR: [{ courseId: null }, { courseId: { in: courseIds } }],
      },
      orderBy: { publishedAt: 'desc' },
      include: {
        _count: { select: { questions: true } },
        teacher: { select: { user: { select: { fullName: true } } } },
      },
    });

    return challenges
      .map((c) => {
        const mine = byChallenge.get(c.id) ?? [];
        const inProgress = mine.some((a) => a.status === 'IN_PROGRESS');
        const completedCount = mine.filter(
          (a) => a.status === 'COMPLETED' || a.status === 'TIMED_OUT',
        ).length;
        const attemptsRemaining =
          c.maxAttempts === 0 ? null : Math.max(0, c.maxAttempts - completedCount);
        const bestScore = mine.reduce<number | null>(
          (b, a) => (a.score == null ? b : b == null ? a.score : Math.max(b, a.score)),
          null,
        );
        return {
          id: c.id,
          title: c.title,
          coverIcon: c.coverIcon,
          type: c.type,
          difficulty: c.difficulty,
          questionCount: c._count.questions,
          durationSec: c.durationSec,
          teacherName: c.teacher.user.fullName,
          topic: c.topic,
          bestScore,
          inProgress,
          attemptsRemaining,
          canPlay: attemptsRemaining == null || attemptsRemaining > 0 || inProgress,
        };
      })
      .filter((c) => {
        if (tab === 'in_progress') return c.inProgress;
        if (tab === 'completed') return c.bestScore != null && !c.inProgress;
        return c.canPlay; // available
      });
  }

  async detailForStudent(userId: string, challengeId: string) {
    const { challenge, studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const questionCount = await this.prisma.challengeQuestion.count({ where: { challengeId } });
    const priorAttempts = await this.prisma.challengeAttempt.findMany({
      where: { challengeId, studentId },
      orderBy: { attemptNumber: 'desc' },
    });
    const completedCount = priorAttempts.filter((a) => a.status !== 'IN_PROGRESS').length;
    const open = priorAttempts.find((a) => a.status === 'IN_PROGRESS');
    return {
      id: challenge.id,
      title: challenge.title,
      description: challenge.description,
      coverIcon: challenge.coverIcon,
      type: challenge.type,
      difficulty: challenge.difficulty,
      questionCount,
      durationSec: challenge.durationSec,
      questionTimeSec: challenge.questionTimeSec,
      scoring: challenge.scoring,
      leaderboardEnabled: challenge.leaderboardEnabled,
      maxAttempts: challenge.maxAttempts,
      attemptsUsed: completedCount,
      attemptsRemaining:
        challenge.maxAttempts === 0 ? null : Math.max(0, challenge.maxAttempts - completedCount),
      openAttemptId: open?.id ?? null,
      bestScore: priorAttempts.reduce<number | null>(
        (b, a) => (b == null ? a.score : Math.max(b, a.score)),
        null,
      ),
    };
  }

  // ── Student attempt lifecycle ──────────────────────────────────────────────

  async startAttempt(userId: string, challengeId: string) {
    const { challenge, studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const questions = await this.prisma.challengeQuestion.findMany({
      where: { challengeId },
      orderBy: { sortOrder: 'asc' },
    });
    if (!questions.length) throw new BadRequestException('Challenge has no questions yet');

    const existing = await this.prisma.challengeAttempt.findMany({
      where: { challengeId, studentId },
    });
    const open = existing.find((a) => a.status === 'IN_PROGRESS');
    if (open) {
      const expired =
        challenge.durationSec != null && this.isOverdue(open.startedAt, challenge.durationSec);
      if (!expired) return this.attemptState(challenge, open, questions);
      await this.finishOverdue(open.id);
    }

    const completedCount = existing.filter((a) => a.status !== 'IN_PROGRESS').length;
    if (challenge.maxAttempts !== 0 && completedCount >= challenge.maxAttempts) {
      throw new BadRequestException({
        message: 'No attempts remaining for this challenge',
        code: 'NO_ATTEMPTS_LEFT',
      });
    }

    const order = this.orderQuestionIds(
      questions,
      challenge.randomize,
      `${studentId}:${challengeId}:${completedCount}`,
    );
    const attempt = await this.prisma.challengeAttempt.create({
      data: {
        challengeId,
        studentId,
        attemptNumber: completedCount + 1,
        questionIds: order,
        deadlineAt:
          challenge.durationSec != null
            ? new Date(Date.now() + challenge.durationSec * 1000)
            : null,
      },
    });
    return this.attemptState(challenge, attempt, questions);
  }

  async getAttempt(userId: string, challengeId: string, attemptId: string) {
    const { challenge, studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const attempt = await this.requireOwnAttempt(studentId, challengeId, attemptId);
    const questions = await this.prisma.challengeQuestion.findMany({ where: { challengeId } });
    return this.attemptState(challenge, attempt, questions);
  }

  /**
   * Submit the next answer in this attempt's own order.
   *
   * Idempotent by (attemptId, questionId): a retried request that already
   * landed just returns what was already scored, never rescoring against a
   * later clock reading. Out-of-order or already-answered question ids are
   * refused outright — the only "current" question is the one the server
   * itself has not yet seen an answer for.
   */
  async answer(
    userId: string,
    challengeId: string,
    attemptId: string,
    dto: SubmitChallengeAnswerDto,
  ) {
    const { challenge, studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const attempt = await this.requireOwnAttempt(studentId, challengeId, attemptId);
    if (attempt.status !== 'IN_PROGRESS') {
      throw new BadRequestException({
        message: 'This attempt is no longer open',
        code: 'ATTEMPT_CLOSED',
      });
    }
    if (challenge.durationSec != null && this.isOverdue(attempt.startedAt, challenge.durationSec)) {
      await this.finishOverdue(attempt.id);
      throw new BadRequestException({
        message: 'Time is up for this attempt',
        code: 'CHALLENGE_TIME_UP',
      });
    }

    const existingAnswers = await this.prisma.challengeAnswer.findMany({
      where: { attemptId },
      orderBy: { answeredAt: 'desc' },
    });
    const answeredIds = new Set(existingAnswers.map((a) => a.questionId));
    const currentQuestionId = attempt.questionIds.find((id) => !answeredIds.has(id));
    if (!currentQuestionId) {
      throw new BadRequestException({
        message: 'Every question has already been answered',
        code: 'ATTEMPT_COMPLETE',
      });
    }
    if (dto.questionId !== currentQuestionId) {
      // Already-answered question id: this is the idempotent-retry path.
      const already = existingAnswers.find((a) => a.questionId === dto.questionId);
      if (already) return this.answerFeedback(challenge, already);
      throw new BadRequestException({
        message: 'Not the current question',
        code: 'QUESTION_OUT_OF_ORDER',
      });
    }

    const question = await this.prisma.challengeQuestion.findFirst({
      where: { id: currentQuestionId, challengeId },
    });
    if (!question) throw new NotFoundException('Question not found');

    const shownAt = existingAnswers[0]?.answeredAt ?? attempt.startedAt;
    const timeTakenMs = Math.max(0, Date.now() - shownAt.getTime());
    const allowedTimeSec = question.timeLimitSec ?? challenge.questionTimeSec ?? null;
    const onTime = this.scoring.isOnTime(timeTakenMs, allowedTimeSec);
    // ChallengeQuestion has no legacy correctOptionId column — isCorrectAnswer
    // only reads it as a fallback when correctOptionIds is empty, which never
    // happens here (publish() refuses to publish a question with none).
    const correct =
      onTime &&
      isCorrectAnswer(
        { ...question, correctOptionId: question.correctOptionIds[0] ?? null },
        dto.selectedOptionIds,
      );
    const { xpAwarded } = this.scoring.scoreAnswer({
      isCorrect: correct,
      onTime,
      basePoints: question.points,
      scoring: challenge.scoring,
      timeTakenMs,
      allowedTimeSec,
    });

    let saved;
    try {
      saved = await this.prisma.challengeAnswer.create({
        data: {
          attemptId,
          questionId: currentQuestionId,
          selectedOptionIds: dto.selectedOptionIds,
          isCorrect: correct,
          timeTakenMs,
          xpAwarded,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const already = await this.prisma.challengeAnswer.findUnique({
          where: { attemptId_questionId: { attemptId, questionId: currentQuestionId } },
        });
        if (already) return this.answerFeedback(challenge, already);
      }
      throw e;
    }
    return this.answerFeedback(challenge, saved);
  }

  /**
   * Finish an attempt: score any questions the student never got to as
   * wrong/zero (a whole-attempt timeout, or ending early), award XP through
   * the one door every reward in this product goes through, and hand back
   * everything the result screen needs. Calling this twice on an already
   * finished attempt is a no-op that returns the same result — completion
   * never pays twice.
   */
  async complete(userId: string, challengeId: string, attemptId: string) {
    const { challenge, studentId } = await this.access.requireStudentAccess(userId, challengeId);
    let attempt = await this.requireOwnAttempt(studentId, challengeId, attemptId);
    if (attempt.status !== 'IN_PROGRESS') {
      return this.resultOf(challenge, attempt);
    }

    const answered = await this.prisma.challengeAnswer.findMany({ where: { attemptId } });
    const answeredIds = new Set(answered.map((a) => a.questionId));
    const unanswered = attempt.questionIds.filter((id) => !answeredIds.has(id));
    if (unanswered.length) {
      await this.prisma.challengeAnswer.createMany({
        data: unanswered.map((questionId) => ({
          attemptId,
          questionId,
          selectedOptionIds: [],
          isCorrect: false,
          timeTakenMs: null,
          xpAwarded: 0,
        })),
        skipDuplicates: true,
      });
    }

    const allAnswers = await this.prisma.challengeAnswer.findMany({ where: { attemptId } });
    const questionsById = new Map(
      (
        await this.prisma.challengeQuestion.findMany({
          where: { id: { in: allAnswers.map((a) => a.questionId) } },
          select: { id: true, timeLimitSec: true },
        })
      ).map((q) => [q.id, q]),
    );
    const summary = this.scoring.summarize(
      allAnswers.map((a) => {
        const allowedTimeSec =
          questionsById.get(a.questionId)?.timeLimitSec ?? challenge.questionTimeSec ?? null;
        const usedFraction =
          challenge.scoring === 'SPEED_BASED' && a.timeTakenMs != null && allowedTimeSec
            ? Math.min(1, Math.max(0, a.timeTakenMs / (allowedTimeSec * 1000)))
            : null;
        return { isCorrect: a.isCorrect, xpAwarded: a.xpAwarded, usedFraction };
      }),
    );
    const overdue =
      challenge.durationSec != null && this.isOverdue(attempt.startedAt, challenge.durationSec);

    attempt = await this.prisma.challengeAttempt.update({
      where: { id: attemptId },
      data: {
        status: overdue ? 'TIMED_OUT' : 'COMPLETED',
        completedAt: new Date(),
        score: summary.score,
        correctCount: summary.correctCount,
        wrongCount: summary.wrongCount,
        accuracyPct: summary.accuracyPct,
        speedPct: summary.speedPct,
      },
    });

    const gamificationOutcome = await this.awardChallenge({
      studentId,
      tenantId: challenge.tenantId,
      courseId: challenge.courseId,
      challengeId,
      attemptId,
      type: challenge.type,
      score: summary.score,
      accuracyPct: summary.accuracyPct,
    });
    await this.prisma.challengeAttempt.update({
      where: { id: attemptId },
      data: {
        xpAwarded: gamificationOutcome?.xp ?? 0,
        coinsAwarded: gamificationOutcome?.coins ?? 0,
      },
    });

    const streak = await this.progress.touchActivity(studentId);
    if (streak?.rolled)
      await this.gamification.checkStreakMilestone(studentId, streak.currentStreak);

    await this.notify(studentId, challenge.title, summary.score, summary.accuracyPct);

    return this.resultOf(
      challenge,
      {
        ...attempt,
        xpAwarded: gamificationOutcome?.xp ?? 0,
        coinsAwarded: gamificationOutcome?.coins ?? 0,
      },
      gamificationOutcome,
    );
  }

  /**
   * A new attempt containing only the questions a completed attempt got
   * wrong — the "learn from your mistakes" loop. Never counted against
   * maxAttempts and never re-scored against the leaderboard as a ranked win:
   * it exists purely for practice, regardless of the original challenge's type.
   */
  async retryMistakes(userId: string, challengeId: string, attemptId: string) {
    const { studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const source = await this.requireOwnAttempt(studentId, challengeId, attemptId);
    if (source.status === 'IN_PROGRESS') {
      throw new BadRequestException({
        message: 'Finish the attempt first',
        code: 'ATTEMPT_IN_PROGRESS',
      });
    }
    const wrong = await this.prisma.challengeAnswer.findMany({
      where: { attemptId, isCorrect: false },
      select: { questionId: true },
    });
    if (!wrong.length) {
      throw new BadRequestException({
        message: 'No mistakes to retry — perfect score',
        code: 'NO_MISTAKES',
      });
    }

    const challenge = await this.prisma.challenge.findUniqueOrThrow({ where: { id: challengeId } });
    const priorAttempts = await this.prisma.challengeAttempt.count({
      where: { challengeId, studentId },
    });
    const attempt = await this.prisma.challengeAttempt.create({
      data: {
        challengeId,
        studentId,
        attemptNumber: priorAttempts + 1,
        questionIds: wrong.map((w) => w.questionId),
        retryOfAttemptId: attemptId,
        // A mistake-retry is never time-boxed by the original whole-challenge
        // duration — it is a short practice pass over a handful of questions,
        // not a re-sitting of the full paper under exam conditions.
        deadlineAt: null,
      },
    });
    const questions = await this.prisma.challengeQuestion.findMany({ where: { challengeId } });
    return this.attemptState(challenge, attempt, questions);
  }

  // ── Leaderboard ─────────────────────────────────────────────────────────────

  async leaderboard(userId: string, challengeId: string) {
    const { studentId } = await this.access.requireStudentAccess(userId, challengeId);
    const top = await this.prisma.challengeAttempt.findMany({
      where: { challengeId, status: { in: ['COMPLETED', 'TIMED_OUT'] } },
      orderBy: [{ score: 'desc' }, { completedAt: 'asc' }],
      take: 20,
      distinct: ['studentId'],
      include: { student: { select: { user: { select: { fullName: true, avatarUrl: true } } } } },
    });
    return top.map((a, i) => ({
      rank: i + 1,
      studentId: a.studentId,
      name: a.student.user.fullName,
      avatarUrl: a.student.user.avatarUrl,
      score: a.score,
      accuracyPct: a.accuracyPct,
      isMe: a.studentId === studentId,
    }));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireOwnAttempt(studentId: string, challengeId: string, attemptId: string) {
    const attempt = await this.prisma.challengeAttempt.findFirst({
      where: { id: attemptId, challengeId, studentId },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    return attempt;
  }

  private isOverdue(startedAt: Date, durationSec: number): boolean {
    return Date.now() > startedAt.getTime() + durationSec * 1000 + ChallengeScoringService.GRACE_MS;
  }

  private async finishOverdue(attemptId: string) {
    await this.prisma.challengeAttempt
      .update({
        where: { id: attemptId },
        data: { status: 'TIMED_OUT', completedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /** Deterministic per-attempt order: a real shuffle, stable across reloads. */
  private orderQuestionIds(
    questions: { id: string; sortOrder: number }[],
    randomize: string,
    seed: string,
  ): string[] {
    const ids = [...questions].sort((a, b) => a.sortOrder - b.sortOrder).map((q) => q.id);
    if (randomize !== 'QUESTIONS' && randomize !== 'BOTH') return ids;
    return this.seededShuffle(ids, seed);
  }

  private seededShuffle<T>(items: T[], seed: string): T[] {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    let state = h >>> 0 || 1;
    const rand = () => {
      // mulberry32
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** The question and progress state a playing student is allowed to see. */
  private async attemptState(
    challenge: {
      id: string;
      durationSec: number | null;
      questionTimeSec: number | null;
      answerReveal: string;
    },
    attempt: {
      id: string;
      status: string;
      startedAt: Date;
      deadlineAt: Date | null;
      questionIds: string[];
    },
    allQuestions: {
      id: string;
      type: string;
      prompt: string;
      imageUrl: string | null;
      options: unknown;
      timeLimitSec: number | null;
      points: number;
    }[],
  ) {
    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const ordered = attempt.questionIds
      .map((id) => byId.get(id))
      .filter((q): q is NonNullable<typeof q> => !!q);
    // How far in the student already is — needed so a refresh/reconnect (§11)
    // resumes on the right question instead of replaying from the start.
    const answeredCount = await this.prisma.challengeAnswer.count({
      where: { attemptId: attempt.id },
    });
    return {
      attemptId: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      serverNow: new Date(),
      totalQuestions: ordered.length,
      answeredCount,
      questions: ordered.map((q, i) => ({
        id: q.id,
        index: i,
        type: q.type,
        prompt: q.prompt,
        imageUrl: q.imageUrl,
        options: q.options,
        timeLimitSec: q.timeLimitSec ?? challenge.questionTimeSec,
        // Shown to the student as "worth N XP" and to animate the live
        // countdown ticker — never a security concern (unlike the answer key,
        // knowing a question's point value ahead of time is exactly what a
        // gamified quiz is supposed to show).
        points: q.points,
      })),
    };
  }

  private async answerFeedback(
    challenge: { answerReveal: string },
    saved: { questionId: string; isCorrect: boolean; xpAwarded: number },
  ) {
    const reveal = challenge.answerReveal === 'IMMEDIATE';
    let correctOptionIds: string[] | undefined;
    let explanation: string | undefined;
    if (reveal) {
      const q = await this.prisma.challengeQuestion.findUnique({ where: { id: saved.questionId } });
      correctOptionIds = q?.correctOptionIds;
      explanation = q?.explanation;
    }
    return {
      questionId: saved.questionId,
      isCorrect: saved.isCorrect,
      xpAwarded: saved.xpAwarded,
      ...(reveal ? { correctOptionIds, explanation } : {}),
    };
  }

  private async resultOf(
    challenge: { id: string; type: string; answerReveal: string; leaderboardEnabled: boolean },
    attempt: {
      id: string;
      status: string;
      score: number;
      correctCount: number;
      wrongCount: number;
      accuracyPct: number | null;
      speedPct: number | null;
      xpAwarded: number;
      coinsAwarded: number;
    },
    gamification?: GamificationOutcome,
  ) {
    const review =
      challenge.answerReveal === 'NEVER'
        ? []
        : await this.prisma.challengeAnswer
            .findMany({
              where: { attemptId: attempt.id },
              include: { question: true },
            })
            .then((rows) =>
              rows.map((r) => ({
                questionId: r.questionId,
                prompt: r.question.prompt,
                yourAnswer: r.selectedOptionIds,
                correctOptionIds: r.question.correctOptionIds,
                isCorrect: r.isCorrect,
                explanation: r.question.explanation,
                topic: r.question.topic,
              })),
            );

    let rank: number | null = null;
    if (challenge.leaderboardEnabled) {
      const ahead = await this.prisma.challengeAttempt.count({
        where: {
          challengeId: challenge.id,
          status: { in: ['COMPLETED', 'TIMED_OUT'] },
          score: { gt: attempt.score },
        },
      });
      rank = ahead + 1;
    }

    return {
      attemptId: attempt.id,
      status: attempt.status,
      score: attempt.score,
      correctCount: attempt.correctCount,
      wrongCount: attempt.wrongCount,
      accuracyPct: attempt.accuracyPct,
      speedPct: attempt.speedPct,
      xpAwarded: attempt.xpAwarded,
      coinsAwarded: attempt.coinsAwarded,
      rank,
      gamification: gamification ?? null,
      mistakes: review.filter((r) => !r.isCorrect),
      review,
    };
  }

  /**
   * What a finished attempt earns — mirrors QuizzesService.awardQuiz: one
   * event for finishing (every time, daily-capped), one for a ranked win
   * (per-challenge), one for a perfect score (per-challenge). All three route
   * through GamificationService.record(), so idempotency, daily caps, level-
   * ups, missions and achievements are exactly the same machinery a quiz uses
   * — nothing about XP or coins is reimplemented here.
   */
  private async awardChallenge(input: {
    studentId: string;
    tenantId: string;
    courseId: string | null;
    challengeId: string;
    attemptId: string;
    type: string;
    score: number;
    accuracyPct: number;
  }): Promise<GamificationOutcome | undefined> {
    const base = {
      studentId: input.studentId,
      tenantId: input.tenantId,
      courseId: input.courseId ?? undefined,
      entityType: 'challenge',
    };
    let last = await this.gamification.record({
      ...base,
      type: 'CHALLENGE_COMPLETED',
      key: `CHALLENGE_COMPLETED:${input.studentId}:${input.attemptId}`,
      entityId: input.attemptId,
      xpOverride: input.score,
      coinsOverride: Math.round(input.score / 5),
      meta: { challengeId: input.challengeId, accuracyPct: input.accuracyPct },
    });
    if (input.type === 'RANKED') {
      const won = await this.gamification.record({
        ...base,
        type: 'CHALLENGE_WON',
        key: `CHALLENGE_WON:${input.studentId}:${input.challengeId}`,
        entityId: input.challengeId,
      });
      if (won.awarded) last = this.merge(last, won);
    }
    if (input.accuracyPct >= 100) {
      const perfect = await this.gamification.record({
        ...base,
        type: 'CHALLENGE_PERFECT',
        key: `CHALLENGE_PERFECT:${input.studentId}:${input.challengeId}`,
        entityId: input.challengeId,
      });
      if (perfect.awarded) last = this.merge(last, perfect);
    }
    return last.awarded ? last : undefined;
  }

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

  private async notify(studentId: string, title: string, score: number, accuracyPct: number) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (!student) return;
    await this.notifications
      .create({
        userId: student.userId,
        type: 'ANNOUNCEMENT',
        title: `أنهيت تحدي «${title}» 🎮`,
        body: `نتيجتك ${score} نقطة بدقة ${accuracyPct}%.`,
        meta: { kind: 'challenge_completed', score, accuracyPct },
      })
      .catch(() => undefined);
  }
}
