import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The exam a course puts in front of you before it lets you in.
 *
 * A teacher names one lesson as the course's exam. Until a student passes it,
 * the course is closed to them except for two things: the exam itself, and
 * whatever the exam sends them to watch when they do not pass. Everything else
 * says why it is shut rather than pretending not to exist.
 *
 * A course that names no exam is untouched by any of this, which is what makes
 * the feature safe to add to a platform full of courses that predate it.
 */
export interface EntryExamState {
  /** The lesson holding the exam, when the course has one. */
  lessonId: string | null;
  /** Whether this student has passed it. True when there is no exam to pass. */
  passed: boolean;
  /** Whether they have submitted at all — a "not yet" versus a "not again". */
  attempted: boolean;
  /** What to watch after failing, if the teacher named something. */
  remedialLessonId: string | null;
  /** Their best score so far, as a percentage, when they have one. */
  bestScorePct: number | null;
  /** Waiting on the teacher to read an essay. */
  awaitingGrading: boolean;
}

/** Nothing to pass, so nothing is locked. */
const OPEN: EntryExamState = {
  lessonId: null,
  passed: true,
  attempted: false,
  remedialLessonId: null,
  bestScorePct: null,
  awaitingGrading: false,
};

@Injectable()
export class EntryExamService {
  constructor(private readonly prisma: PrismaService) {}

  /** Where this student stands with the course's entry exam. */
  async stateFor(courseId: string, studentId: string | null): Promise<EntryExamState> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: { examLessonId: true },
    });
    if (!course?.examLessonId) return OPEN;

    const quiz = await this.prisma.quiz.findUnique({
      where: { lessonId: course.examLessonId },
      select: { id: true, remedialLessonId: true },
    });
    const base = {
      lessonId: course.examLessonId,
      remedialLessonId: quiz?.remedialLessonId ?? null,
    };
    // A visitor has nothing to have passed; the page shows the exam as the door.
    if (!studentId || !quiz) {
      return { ...base, passed: false, attempted: false, bestScorePct: null, awaitingGrading: false };
    }

    const attempts = await this.prisma.quizAttempt.findMany({
      where: { quizId: quiz.id, studentId },
      select: { passed: true, scorePct: true, needsManualGrading: true, gradedAt: true },
    });
    const best = attempts.reduce<number | null>(
      (acc, a) => (a.scorePct == null ? acc : acc == null ? a.scorePct : Math.max(acc, a.scorePct)),
      null,
    );
    return {
      ...base,
      passed: attempts.some((a) => a.passed === true),
      attempted: attempts.length > 0,
      bestScorePct: best,
      // Only genuinely waiting: a verdict that is already decided is not.
      awaitingGrading: attempts.some((a) => a.passed == null && a.needsManualGrading && !a.gradedAt),
    };
  }

  /**
   * Is this lesson open to a student who has not passed the exam?
   *
   * The exam itself, obviously, and the one thing it sends them to watch. A
   * free preview stays free — it is the shop window, and closing it would hide
   * the course from people deciding whether to buy it.
   */
  isAllowedWhileLocked(state: EntryExamState, lessonId: string, isFreePreview: boolean): boolean {
    if (state.passed) return true;
    if (isFreePreview) return true;
    return lessonId === state.lessonId || lessonId === state.remedialLessonId;
  }

  /**
   * Refuse a lesson the exam is still holding shut.
   *
   * The code is the point: the client uses it to send the student to the exam
   * rather than showing them a bare refusal they can do nothing about.
   */
  async requirePassed(courseId: string, studentId: string, lessonId: string, isFreePreview: boolean) {
    const state = await this.stateFor(courseId, studentId);
    if (this.isAllowedWhileLocked(state, lessonId, isFreePreview)) return state;
    throw new ForbiddenException({
      message: 'Pass the course exam first',
      code: 'ENTRY_EXAM_REQUIRED',
      examLessonId: state.lessonId,
      remedialLessonId: state.remedialLessonId,
    });
  }
}
