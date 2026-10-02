import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsId } from '../common/validation';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** One user action's identity: a retry or a double click reuses it. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
/** 1000.00 marks, in hundredths. */
export const MAX_MARKS = 100_000;

/*
 * Scores are integer HUNDREDTHS (26.5 marks → 2650): the browser turns what is
 * typed into hundredths with string arithmetic; no float reaches the API. Who
 * acted, when, an exam's status, publication, voiding, a result's version
 * history and the academy are the server's — the global pipe refuses any field
 * not declared here (academyId, createdBy, enteredBy, correctedBy, publishedAt,
 * publishedBy, voidedBy, status, version, makeupKey…) with a 400.
 */

export class CreateExamDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsId() groupId: string;
  @IsString() @MinLength(1) @MaxLength(120) title: string;
  @Matches(DATE) examDate: string;
  @IsInt() @Min(1) @Max(MAX_MARKS) maxScore: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MARKS) passScore?: number;
  @IsOptional() @IsId() groupSessionId?: string;
  @IsOptional() @IsId() subjectId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) note?: string;
}

export class CreateMakeupDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @Matches(DATE) examDate: string;
  @IsOptional() @IsId() groupSessionId?: string;
}

export class UpdateExamDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string | null;
  @IsOptional() @Matches(DATE) examDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_MARKS) maxScore?: number;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_MARKS)
  passScore?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() groupSessionId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() subjectId?: string | null;
}

export class ResultRowDto {
  @IsId() academyStudentId: string;
  /** null clears the learner's result (draft only). */
  @ValidateIf((_, v) => v !== null)
  @IsIn(['SCORED', 'ABSENT', 'EXCUSED'])
  status: 'SCORED' | 'ABSENT' | 'EXCUSED' | null;
  @ValidateIf((o) => o.status === 'SCORED') @IsInt() @Min(0) @Max(MAX_MARKS) score?: number;
  /** The version the editor saw; absent for a learner with no result yet. */
  @IsOptional() @IsInt() @Min(1) version?: number;
  /** Add a learner who is not on the exam date's roster, on purpose. */
  @IsOptional() @IsBoolean() guest?: boolean;
}

export class SaveResultsDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ResultRowDto)
  rows: ResultRowDto[];
}

export class CorrectDto {
  @IsInt() @Min(1) version: number;
  @IsIn(['SCORED', 'ABSENT', 'EXCUSED']) status: 'SCORED' | 'ABSENT' | 'EXCUSED';
  @ValidateIf((o) => o.status === 'SCORED') @IsInt() @Min(0) @Max(MAX_MARKS) score?: number;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class VoidDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ExamsQuery {
  @IsOptional() @IsId() groupId?: string;
  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED', 'VOID']) status?: 'DRAFT' | 'PUBLISHED' | 'VOID';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class GradeSettingsDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) lowGradePercent?: number;
  @IsOptional() @IsBoolean() guardianGradesVisible?: boolean;
}
