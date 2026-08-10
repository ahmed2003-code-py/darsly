import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
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

export class UpsertQuizDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) passingScore?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_TIME_LIMIT_SEC) timeLimitSec?: number | null;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxAttempts?: number | null;
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
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true }) @Type(() => QuizOptionDto)
  options?: QuizOptionDto[];
  @IsOptionalId() correctOptionId?: string | null;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) explanation?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1_000) points?: number;
}

export class SetQuizQuestionsDto {
  @IsArray() @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true }) @Type(() => QuizQuestionDto)
  questions: QuizQuestionDto[];
}

export class SubmitAttemptDto {
  // { [questionId]: optionId | freeText }. Bounded rather than a bare object:
  // the grader iterates every key, so an unbounded map is billable CPU.
  @IsBoundedRecord({ maxKeys: MAX_QUESTIONS, maxValueLength: LIMITS.PROSE })
  answers: Record<string, string>;
}

export class GradeAttemptDto {
  // Manual points awarded per short-answer question: { [questionId]: points }
  @IsBoundedRecord({ maxKeys: MAX_QUESTIONS })
  scores: Record<string, number>;
}
