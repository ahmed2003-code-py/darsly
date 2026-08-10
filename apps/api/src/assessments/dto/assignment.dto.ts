import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { LIMITS } from '../../common/validation';

/** Grades are out of `maxScore`; nothing sane needs a scale beyond this. */
const MAX_SCORE = 10_000;

export class UpsertAssignmentDto {
  @IsString() @MaxLength(LIMITS.PROSE) prompt: string;
  // ISO-8601, not any string: the service feeds this straight to `new Date()`,
  // where a junk value becomes an Invalid Date rather than a rejected request.
  @IsOptional() @IsISO8601() dueAt?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_SCORE) maxScore?: number;
}

export class SubmitAssignmentDto {
  @IsOptional() @IsString() @MaxLength(LIMITS.PROSE) body?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.URL) fileKey?: string | null;
}

export class GradeSubmissionDto {
  @IsInt() @Min(0) @Max(MAX_SCORE) score: number;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) feedback?: string;
}
