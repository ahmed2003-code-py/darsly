import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CourseExamMode } from '@darsly/shared-types';
import { IsOptionalId, LIMITS } from '../../common/validation';
import { SPEC_LIMITS } from '../exam-spec';

/** Mirrors SetQuizQuestionsDto's ceilings: a draft that could not be saved as
 *  a quiz should be refused while it is still a draft. */
const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 20;
const MAX_SECTIONS = 40;
const MAX_INSTRUCTIONS = 20;

export class DraftOptionDto {
  @IsString() @MaxLength(LIMITS.ID) id: string;
  @IsString() @MaxLength(LIMITS.NAME) label: string;
  @IsString() @MaxLength(LIMITS.NOTE) text: string;
  @IsBoolean() correct: boolean;
}

export class DraftQuestionDto {
  @IsString() @MaxLength(LIMITS.ID) id: string;
  @IsInt() @Min(0) @Max(10_000) number: number;
  @IsIn(['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'UNSUPPORTED'])
  type: 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'UNSUPPORTED';
  @IsString() @MaxLength(LIMITS.PROSE) text: string;
  @IsArray()
  @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => DraftOptionDto)
  options: DraftOptionDto[];
  @IsString() @MaxLength(LIMITS.PROSE) modelAnswer: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000) marks?: number | null;
  @IsArray() @ArrayMaxSize(50) @IsInt({ each: true }) sourcePages: number[];
  @IsString() @MaxLength(LIMITS.NAME) unsupportedKind: string;
  @IsBoolean() needsReview: boolean;
}

export class DraftSectionDto {
  @IsString() @MaxLength(LIMITS.TITLE) title: string;
  @IsArray()
  @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => DraftQuestionDto)
  questions: DraftQuestionDto[];
}

/** The whole draft, as the review screen sends it back after editing. Replaced
 *  wholesale rather than patched: the screen owns the list, the same way the
 *  quiz builder owns its question set. */
export class SaveDraftDto {
  @IsString() @MaxLength(LIMITS.TITLE) title: string;
  @IsArray()
  @ArrayMaxSize(MAX_INSTRUCTIONS)
  @IsString({ each: true })
  @MaxLength(LIMITS.NOTE, { each: true })
  instructions: string[];
  @IsArray()
  @ArrayMaxSize(MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => DraftSectionDto)
  sections: DraftSectionDto[];
}

export class ConfirmImportDto {
  @IsIn(['NEW_COURSE', 'EXISTING_COURSE'])
  target: 'NEW_COURSE' | 'EXISTING_COURSE';
  /** Required for EXISTING_COURSE; ignored otherwise. */
  @IsOptionalId() courseId?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.TITLE) title?: string;
  /** Name this exam as the course's exam. Defaults on for a new course. */
  @IsOptional() @IsBoolean() setAsCourseExam?: boolean;
  @IsOptional() @IsEnum(CourseExamMode) examMode?: CourseExamMode;
  /** The teacher has seen the unsupported questions and accepts losing them. */
  @IsOptional() @IsBoolean() dropUnsupported?: boolean;
}

/**
 * "Read the pages again."
 *
 * Two different requests wearing one button. The default re-reads the pages
 * that failed and nothing else, which costs a page or two. `escalate` re-reads
 * the WHOLE paper on the flagship model, which is what a teacher wants when
 * the result was structurally fine and simply wrong — old handwriting read as
 * five identical questions. It costs real money, so it is never automatic and
 * never implied: the teacher asks for it by name.
 */
export class RetryImportDto {
  @IsOptional() @IsBoolean() escalate?: boolean;
}

/** How many of each supported kind. Exactly the exam engine's three types —
 *  a fourth on the form would be a promise the exam cannot keep. */
export class SpecTypesDto {
  @IsInt() @Min(0) @Max(SPEC_LIMITS.MAX_QUESTIONS) MCQ: number;
  @IsInt() @Min(0) @Max(SPEC_LIMITS.MAX_QUESTIONS) TRUE_FALSE: number;
  @IsInt() @Min(0) @Max(SPEC_LIMITS.MAX_QUESTIONS) SHORT_ANSWER: number;
}

/** Percentages, only meaningful when the difficulty is "متنوع". */
export class SpecMixDto {
  @IsInt() @Min(0) @Max(100) EASY: number;
  @IsInt() @Min(0) @Max(100) MEDIUM: number;
  @IsInt() @Min(0) @Max(100) HARD: number;
}

/**
 * What the teacher wants out of the material they uploaded.
 *
 * Bounded at the edge as well as in `specProblems`, because the two answer
 * different questions: this refuses a payload that is not a spec at all, and
 * that refuses a spec that could not become an exam.
 */
export class SetSpecDto {
  @IsInt()
  @Min(SPEC_LIMITS.MIN_QUESTIONS)
  @Max(SPEC_LIMITS.MAX_QUESTIONS)
  questionCount: number;

  @IsIn(['EASY', 'MEDIUM', 'HARD', 'MIXED'])
  difficulty: 'EASY' | 'MEDIUM' | 'HARD' | 'MIXED';

  @IsOptional() @ValidateNested() @Type(() => SpecMixDto) mix?: SpecMixDto;

  @ValidateNested() @Type(() => SpecTypesDto) types: SpecTypesDto;

  @IsOptional() @IsString() @MaxLength(LIMITS.TITLE) title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(LIMITS.NOTE, { each: true })
  instructions?: string[];

  @IsOptional() @IsInt() @Min(1) @Max(SPEC_LIMITS.MAX_MARKS) marksPerQuestion?: number | null;
  @IsOptional()
  @IsInt()
  @Min(SPEC_LIMITS.MIN_TIME_MIN)
  @Max(SPEC_LIMITS.MAX_TIME_MIN)
  timeLimitMin?: number | null;

  @IsOptional() @IsIn(['AUTO', 'AR', 'EN']) language?: 'AUTO' | 'AR' | 'EN';
  @IsOptional() @IsBoolean() shuffle?: boolean;
  @IsOptional() @IsBoolean() showAnswers?: boolean;
}

/** Why the teacher wants this one written again. Optional, and sent to the
 *  model so the rewrite is not the same question a second time. */
export class RegenerateQuestionDto {
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) reason?: string;
}
