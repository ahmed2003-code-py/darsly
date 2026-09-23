import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuestionType } from '@darsly/shared-types';
import { IsBoundedRecord, IsOptionalId, LIMITS } from '../../common/validation';

/** One quiz's ceiling. Past this a "quiz" is a bulk-write vector, not a quiz. */
const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 20;
/** A day — a longer limit is indistinguishable from no limit. */
const MAX_TIME_LIMIT_SEC = 86_400;
/** Half a minute: below this nobody can read the paper, let alone answer it. */
const MIN_TIME_LIMIT_SEC = 30;
/**
 * How close to the model answer may count as right.
 *
 * The floor is not 0: a threshold low enough to pass any answer at all is not a
 * marking scheme, it is marks for turning up, and a teacher who wants that has
 * the feature switched off instead. The ceiling is not 100 either — demanding a
 * perfect match would fail a correct answer in the student's own words, which
 * is the thing this is for.
 */
const MIN_AI_THRESHOLD_PCT = 30;
const MAX_AI_THRESHOLD_PCT = 95;

export class UpsertQuizDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) passingScore?: number;
  /** The lesson to send a student to when they do not pass. `null` clears it. */
  @IsOptionalId() remedialLessonId?: string | null;
  /** Seconds from opening the paper to sending it. `null` removes the limit. */
  @IsOptional() @IsInt() @Min(MIN_TIME_LIMIT_SEC) @Max(MAX_TIME_LIMIT_SEC) timeLimitSec?:
    number | null;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  /** How many times a student may sit it. `null` is unlimited. */
  @IsOptional() @IsInt() @Min(1) @Max(50) maxAttempts?: number | null;
  /** Mark the written answers against the model answer instead of queueing them. */
  @IsOptional() @IsBoolean() aiGrading?: boolean;
  @IsOptional()
  @IsInt()
  @Min(MIN_AI_THRESHOLD_PCT)
  @Max(MAX_AI_THRESHOLD_PCT)
  aiThresholdPct?: number;
  /** Whether the student sees the right answers once they are done with it. */
  @IsOptional() @IsBoolean() showAnswers?: boolean;
}

export class QuizOptionDto {
  @IsString() @MaxLength(LIMITS.ID) id: string;
  @IsString() @MaxLength(LIMITS.NOTE) text: string;
}

export class QuizQuestionDto {
  // Was a free string typed as QuestionType — the annotation promised an enum
  // the validator never enforced, so any word reached the grading switch.
  @IsOptional() @IsEnum(QuestionType) type?: QuestionType;
  @IsString() @MaxLength(LIMITS.PROSE) prompt: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  options?: QuizOptionDto[];
  @IsOptionalId() correctOptionId?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @IsString({ each: true })
  correctOptionIds?: string[];
  /** How many the student may pick. Bounded by the option count on save. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_OPTIONS) maxSelections?: number;
  @IsOptional() @IsString() @MaxLength(LIMITS.PROSE) modelAnswer?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) explanation?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1_000) points?: number;
}

export class SetQuizQuestionsDto {
  @IsArray()
  @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionDto)
  questions: QuizQuestionDto[];
  /**
   * The automatic-marking setting being saved alongside these questions.
   *
   * The builder saves the settings and the question set as two calls, so the
   * rule "no written question without a model answer while automatic marking is
   * on" has to be checked against what is about to be true rather than what is
   * currently stored — otherwise switching it off in the same edit as adding a
   * question is refused by the stored value, and cannot be saved at all.
   * Omitted means "unchanged", and the stored value is used.
   */
  @IsOptional() @IsBoolean() aiGrading?: boolean;
}

export class SubmitAttemptDto {
  // { [questionId]: optionId | optionId[] | freeText }. Bounded rather than a
  // bare object: the grader iterates every key, so an unbounded map is billable
  // CPU. An array arrives for a question that asks for more than one answer.
  @IsBoundedRecord({
    maxKeys: MAX_QUESTIONS,
    maxValueLength: LIMITS.PROSE,
    allowArrays: MAX_OPTIONS,
  })
  answers: Record<string, string | string[]>;

  /**
   * This sitting's identity, made by the page when the paper is opened and
   * sent with every try at submitting it. The same key twice is the same
   * submission: the second gets the first one's result, and no second attempt
   * is recorded. Optional so a page loaded before this existed still works —
   * the server then derives one from the answers.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  submitKey?: string;
}

export class GradeAttemptDto {
  // Manual points awarded per short-answer question: { [questionId]: points }
  @IsBoundedRecord({ maxKeys: MAX_QUESTIONS })
  scores: Record<string, number>;
}
