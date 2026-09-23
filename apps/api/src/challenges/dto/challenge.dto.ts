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
import {
  ChallengeAnswerReveal,
  ChallengeRandomize,
  ChallengeScoring,
  ChallengeType,
  QuestionType,
} from '@darsly/shared-types';
import { IsOptionalId, LIMITS } from '../../common/validation';

/** Same ceiling as a Quiz — past this a "challenge" is a bulk-write vector. */
const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 20;
/** A day — a longer limit is indistinguishable from no limit. */
const MAX_TIME_LIMIT_SEC = 86_400;
/** Half a minute: below this nobody can read a question, let alone answer it. */
const MIN_TIME_LIMIT_SEC = 10;

export class UpsertChallengeDto {
  @IsString() @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) coverIcon?: string;
  @IsOptional() @IsEnum(ChallengeType) type?: ChallengeType;
  @IsOptional() @IsInt() @Min(1) @Max(5) difficulty?: number;

  @IsOptionalId() courseId?: string | null;
  @IsOptionalId() subjectId?: string | null;
  @IsOptionalId() gradeId?: string | null;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) topic?: string | null;

  /** Whole-challenge time budget in seconds. `null` removes the limit. */
  @IsOptional() @IsInt() @Min(MIN_TIME_LIMIT_SEC) @Max(MAX_TIME_LIMIT_SEC) durationSec?:
    number | null;
  /** Default per-question time budget in seconds. `null` removes the limit. */
  @IsOptional() @IsInt() @Min(MIN_TIME_LIMIT_SEC) @Max(MAX_TIME_LIMIT_SEC) questionTimeSec?:
    number | null;
  @IsOptional() @IsEnum(ChallengeScoring) scoring?: ChallengeScoring;
  /** How many times a student may play it. `0` is unlimited. */
  @IsOptional() @IsInt() @Min(0) @Max(50) maxAttempts?: number;
  @IsOptional() @IsBoolean() leaderboardEnabled?: boolean;
  @IsOptional() @IsEnum(ChallengeAnswerReveal) answerReveal?: ChallengeAnswerReveal;
  @IsOptional() @IsEnum(ChallengeRandomize) randomize?: ChallengeRandomize;
}

export class ChallengeOptionDto {
  @IsString() @MaxLength(LIMITS.ID) id: string;
  @IsString() @MaxLength(LIMITS.NOTE) text: string;
}

export class ChallengeQuestionDto {
  @IsOptional() @IsEnum(QuestionType) type?: QuestionType;
  @IsString() @MaxLength(LIMITS.PROSE) prompt: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.URL) imageUrl?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => ChallengeOptionDto)
  options?: ChallengeOptionDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @IsString({ each: true })
  correctOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) explanation?: string;
  /** Base XP for a correct answer — the scoring engine's speed multiplier
   *  applies on top of this, it is never a raw "point" like a quiz. */
  @IsOptional() @IsInt() @Min(1) @Max(1_000) points?: number;
  /** Overrides the challenge's default question timer. `null` clears it. */
  @IsOptional() @IsInt() @Min(MIN_TIME_LIMIT_SEC) @Max(MAX_TIME_LIMIT_SEC) timeLimitSec?:
    number | null;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) topic?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) difficulty?: number;
}

export class SetChallengeQuestionsDto {
  @IsArray()
  @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => ChallengeQuestionDto)
  questions: ChallengeQuestionDto[];
}

/** One question, answered. Timing is measured server-side — see
 *  ChallengesService.answer — this is advisory only and never trusted for scoring. */
export class SubmitChallengeAnswerDto {
  @IsString() @MaxLength(LIMITS.ID) questionId: string;
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @IsString({ each: true })
  selectedOptionIds: string[];
}
