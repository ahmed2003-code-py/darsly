import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CourseExamMode, LessonType, QuestionType } from '@darsly/shared-types';
import { CourseScope, CoursesService } from '../courses/courses.service';
import { QuizQuestionDto } from '../assessments/dto/quiz.dto';
import { QuizzesService } from '../assessments/quizzes.service';
import { ExamSpec } from './exam-spec';
import { PrismaService } from '../prisma/prisma.service';
import { DraftQuestion, ExamDraft } from './extraction.schema';

/** Ceilings taken from SetQuizQuestionsDto, so a draft that would be refused
 *  by the quiz API is refused here with a sentence about the paper instead of
 *  a validation error about a DTO. */
const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 20;
const MAX_POINTS = 1_000;

export interface ConfirmTarget {
  /** NEW_COURSE covers both "just an exam" and "a course that is only this
   *  exam": in this schema they are the same thing, because an exam lives on
   *  a lesson and a lesson lives in a course. Saying so is honest; inventing a
   *  second course-shaped domain to avoid saying it would not be. */
  target: 'NEW_COURSE' | 'EXISTING_COURSE';
  courseId?: string;
  /** Overrides the draft's own title for the course and the lesson. */
  title?: string;
  /** Name this exam as the course's exam (Course.examLessonId). Always true
   *  for a new exam-only course — that is what makes it exam-only. */
  setAsCourseExam?: boolean;
  examMode?: 'GATE' | 'FINAL';
  /**
   * The one school year a new exam course is for. Required for NEW_COURSE:
   * left out, the course fell back to every year the teacher teaches, and the
   * printed paper read "Grade: Secondary 1, Secondary 2, … Baccalaureate 3".
   */
  gradeId?: string;
  /** Which of the teacher's subjects; needed only when they teach several. */
  subjectId?: string;
  /** The teacher has seen the unsupported questions and accepted losing them.
   *  Without this, confirming a draft that still holds one is refused — a
   *  question silently dropped is a question the class never gets asked. */
  dropUnsupported?: boolean;
}

export interface BuiltExam {
  courseId: string;
  lessonId: string;
  questionCount: number;
  droppedUnsupported: number;
}

/**
 * The confirmed draft, written into the exam system that already exists.
 *
 * Everything here goes through `CoursesService` and `QuizzesService` — the
 * same two services the manual builder calls. That is the whole point of the
 * feature: what comes out the other end is an ordinary `Quiz` on an ordinary
 * QUIZ `Lesson`, indistinguishable from one typed in by hand, so attempts,
 * grading, gating, certificates, progress and the student player need to know
 * nothing about paper.
 */
@Injectable()
export class ExamBuilderService {
  private readonly logger = new Logger(ExamBuilderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly quizzes: QuizzesService,
  ) {}

  /**
   * Turn a draft into a real exam.
   *
   * Not one transaction, because it cannot be: the two services it calls own
   * their own writes, and wrapping them would mean reaching around them into
   * Prisma — duplicating the ownership checks, the default-unit logic and the
   * lesson-type flip that are the reason for calling them at all. What the
   * steps do instead is fail forwards: a course with an empty exam lesson in
   * it is a visible, editable, deletable thing, and the import is only marked
   * COMPLETED once every step has run.
   */
  async build(
    scope: CourseScope,
    draft: ExamDraft,
    opts: ConfirmTarget,
    /**
     * What the teacher already chose for this exam in the Studio — time,
     * shuffling, whether answers are shown. Omitted for a paper import, which
     * asks none of it, so the exam gets the builder's own defaults.
     */
    settings?: Pick<ExamSpec, 'timeLimitMin' | 'shuffle' | 'showAnswers'>,
  ): Promise<BuiltExam> {
    const questions = this.flatten(draft);
    const unsupported = questions.filter((q) => q.type === 'UNSUPPORTED');
    if (unsupported.length && !opts.dropUnsupported) {
      throw new BadRequestException({
        message:
          'Some questions are of a type this platform cannot store. Change them, delete them, or confirm that they may be left out.',
        code: 'UNSUPPORTED_QUESTIONS',
        questions: unsupported.map((q) => ({
          number: q.number,
          kind: q.unsupportedKind,
          text: q.text.slice(0, 120),
        })),
      });
    }
    const keep = questions.filter((q) => q.type !== 'UNSUPPORTED');
    if (!keep.length) {
      throw new BadRequestException({
        message: 'There are no questions to make an exam from',
        code: 'NO_QUESTIONS',
      });
    }
    if (keep.length > MAX_QUESTIONS) {
      throw new BadRequestException({
        message: `An exam can hold ${MAX_QUESTIONS} questions; this draft has ${keep.length}`,
        code: 'TOO_MANY_QUESTIONS',
      });
    }

    const title = (opts.title || draft.title || 'Imported exam').slice(0, 120);

    let courseId: string;
    if (opts.target === 'EXISTING_COURSE') {
      if (!opts.courseId) {
        throw new BadRequestException({
          message: 'Choose the course this exam belongs to',
          code: 'COURSE_REQUIRED',
        });
      }
      // Ownership is not checked here — `addLessonDirect` asserts the course
      // belongs to this scope, and a second check written by hand is a second
      // check that can drift from the first.
      courseId = opts.courseId;
    } else {
      if (!opts.gradeId) {
        throw new BadRequestException({
          message: 'Choose the school year this exam is for',
          code: 'GRADE_REQUIRED',
        });
      }
      // Whether the year and subject are the teacher's own is checked by
      // `courses.create`, the same as for a course made by hand.
      const course = await this.courses.create(
        scope,
        {
          title,
          description: draft.instructions.join('\n').slice(0, 5_000),
          gradeIds: [opts.gradeId],
          ...(opts.subjectId ? { subjectId: opts.subjectId } : {}),
        },
        // Recorded, not derived: the builder shows an exam course the exam
        // rather than "add a section, name a lesson, upload a video".
        { kind: 'EXAM' },
      );
      courseId = course.id;
    }

    const lesson = await this.courses.addLessonDirect(scope, courseId, {
      title,
      description: draft.instructions.join('\n').slice(0, 5_000) || undefined,
      type: LessonType.QUIZ,
    });

    // Creates the Quiz row and flips the lesson to QUIZ, exactly as the
    // manual builder's first save does — carrying the settings the teacher
    // already chose in the Studio. It used to pass nothing, so the time limit
    // and the shuffle they had set came back as "no limit" and unticked in the
    // builder, to be set a second time.
    await this.quizzes.upsertForTeacher(
      scope.authorTenantId!,
      lesson.id,
      settings
        ? {
            timeLimitSec: settings.timeLimitMin ? settings.timeLimitMin * 60 : null,
            shuffleQuestions: settings.shuffle,
            showAnswers: settings.showAnswers,
          }
        : {},
    );
    await this.quizzes.setQuestions(scope.authorTenantId!, lesson.id, {
      questions: keep.map((q) => this.toQuizQuestion(q)),
    });

    // A new course exists for this exam, so the exam is what it is for.
    const nameIt = opts.setAsCourseExam ?? opts.target === 'NEW_COURSE';
    if (nameIt) {
      await this.courses.update(scope, courseId, {
        examLessonId: lesson.id,
        examMode: (opts.examMode ?? 'FINAL') as CourseExamMode,
      });
    }

    this.logger.log(
      `Imported exam ${lesson.id} (${keep.length} questions) into course ${courseId}`,
    );
    return {
      courseId,
      lessonId: lesson.id,
      questionCount: keep.length,
      droppedUnsupported: unsupported.length,
    };
  }

  /** Sections are a reading aid on the paper; the exam model has one flat
   *  question list. The heading is folded into the first question's prompt so
   *  the information is not simply thrown away. */
  private flatten(draft: ExamDraft): DraftQuestion[] {
    const out: DraftQuestion[] = [];
    for (const section of draft.sections ?? []) {
      let first = true;
      for (const q of section.questions ?? []) {
        out.push(
          first && section.title?.trim() ? { ...q, text: `${section.title.trim()}\n${q.text}` } : q,
        );
        first = false;
      }
    }
    return out;
  }

  private toQuizQuestion(q: DraftQuestion): QuizQuestionDto {
    const options = (q.options ?? []).slice(0, MAX_OPTIONS).map((o) => ({
      id: o.id,
      // The printed label is kept in front of the text, because a teacher
      // checking a question against the paper looks for "ب)" and a student
      // reading a past paper expects the same lettering.
      text: (o.label ? `${o.label}) ${o.text}` : o.text).slice(0, 1_000),
    }));
    const correct = (q.options ?? [])
      .filter((o) => o.correct)
      .map((o) => o.id)
      .filter((id) => options.some((o) => o.id === id));

    return {
      type:
        q.type === 'TRUE_FALSE'
          ? QuestionType.TRUE_FALSE
          : q.type === 'SHORT_ANSWER'
            ? QuestionType.SHORT_ANSWER
            : QuestionType.MCQ,
      prompt: q.text.slice(0, 5_000),
      options: q.type === 'SHORT_ANSWER' ? [] : options,
      correctOptionIds: q.type === 'SHORT_ANSWER' ? [] : correct,
      // "Choose two" is a different question from "choose the one that is
      // true", and the paper says which by marking two answers.
      maxSelections: Math.max(1, Math.min(correct.length || 1, MAX_OPTIONS)),
      modelAnswer: (q.modelAnswer ?? '').slice(0, 5_000),
      explanation: '',
      points: Math.max(1, Math.min(Math.round(q.marks ?? 1) || 1, MAX_POINTS)),
    };
  }
}
