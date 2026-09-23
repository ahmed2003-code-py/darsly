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
