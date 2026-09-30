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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsId, LIMITS } from '../common/validation';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A class of 40 is the working case; 200 is the ceiling a request may carry. */
const MAX_MARKS = 200;

/**
 * A weekly timetable line. Times are the academy's wall clock; the server
 * owns everything derived from them (instants, occurrences, who created it).
 * The global pipe forbids any field not listed here.
 */
export class CreateSlotDto {
  /** 0 = Sunday … 6 = Saturday. */
  @IsInt() @Min(0) @Max(6) weekday: number;
  /** 'HH:MM', 24-hour, academy local time. */
  @IsString() @Matches(CLOCK) startTime: string;
  @IsInt() @Min(15) @Max(600) durationMin: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() roomId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() teacherUserId?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['CENTER', 'TEACHER', 'STUDENT', 'OTHER'])
  locationType?: 'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(LIMITS.NAME)
  locationNote?: string | null;
  /** First local date (defaults to today). */
  @IsOptional() @IsString() @Matches(DATE) validFrom?: string;
  /** Last local date, inclusive; null = open-ended. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Matches(DATE) validTo?:
    string | null;
  /** The client's key for this save: a retry or double click returns the first slot. */
  @IsOptional() @IsString() @MaxLength(LIMITS.ID) requestKey?: string;
}

export class UpdateSlotDto {
  @IsOptional() @IsInt() @Min(0) @Max(6) weekday?: number;
  @IsOptional() @IsString() @Matches(CLOCK) startTime?: string;
  @IsOptional() @IsInt() @Min(15) @Max(600) durationMin?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() roomId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsId() teacherUserId?: string | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['CENTER', 'TEACHER', 'STUDENT', 'OTHER'])
  locationType?: 'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(LIMITS.NAME)
  locationNote?: string | null;
  @IsOptional() @IsString() @Matches(DATE) validFrom?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Matches(DATE) validTo?:
    string | null;
  /** true: report what the change would do, change nothing. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class MarkInput {
  @IsId() studentId: string;
  @IsIn(['PRESENT', 'LATE', 'ABSENT', 'EXCUSED']) status: 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED';
}

export class MarkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MARKS)
  @ValidateNested({ each: true })
  @Type(() => MarkInput)
  records: MarkInput[];
}

export class MakeupDto {
  @IsId() studentId: string;
  /** The student's own group, when they are in more than one. */
  @IsOptional() @IsId() homeGroupId?: string;
  /** The home-group class this attendance makes up for. */
  @IsOptional() @IsId() makeupForSessionId?: string;
}

export class DayQuery {
  @IsOptional() @IsString() @Matches(DATE) date?: string;
}

export class RangeQuery {
  @IsString() @Matches(DATE) from: string;
  @IsString() @Matches(DATE) to: string;
}

export class CandidateQuery {
  @IsString() @MaxLength(LIMITS.NAME) q: string;
}
