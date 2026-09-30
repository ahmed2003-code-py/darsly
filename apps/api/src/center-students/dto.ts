import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsId, IsOptionalId, IsPage, IsPageSize, LIMITS } from '../common/validation';

/**
 * Inputs to the student register. Only what a person at a desk decides is
 * accepted: the academy is the request's context, and status, source, code,
 * the search key and every id the server derives are never read from a body
 * (the global pipe rejects unknown fields outright).
 */

/** The most rows one spreadsheet may carry (the JSON body limit sits above it). */
export const IMPORT_MAX_ROWS = 5_000;

/** A retry-safe request identity: generated once per user action by the client. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export class ListStudentsQuery {
  @ApiPropertyOptional({ description: 'Code, phone, or (part of) a name' })
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  q?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'WITHDRAWN', 'ALL'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'WITHDRAWN', 'ALL'])
  status?: 'ACTIVE' | 'WITHDRAWN' | 'ALL';

  @IsPage()
  @Type(() => Number)
  page?: number;

  @IsPageSize(50)
  @Type(() => Number)
  pageSize?: number;
}

export class RegisterStudentDto {
  @ApiProperty({
    description:
      'Client-generated once per registration attempt; a repeat returns the first result',
  })
  @IsString()
  @Matches(REQUEST_KEY)
  requestKey!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(LIMITS.NAME)
  fullName!: string;

  @IsOptionalId()
  gradeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  studentPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  guardianName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  guardianPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  school?: string;

  /** Enrol into this group in the same transaction. */
  @IsOptionalId()
  groupId?: string;

  /** The operator saw the possible-duplicate warning and says this is a different person. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;
}

/** Edit what the academy records. Omitted fields are unchanged; null clears an optional one. */
export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(LIMITS.NAME)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.ID)
  gradeId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  studentPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  guardianName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  guardianPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  school?: string | null;
}

export class AddToGroupDto {
  @IsId()
  groupId!: string;
}

/** One spreadsheet row, as the browser read it — raw text only; the server interprets it. */
export class ImportRowDto {
  /** The row's number in the sheet, for the operator's error report. */
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  row!: number;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  studentPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  guardianName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  guardianPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  school?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  grade?: string;

  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.NAME)
  group?: string;
}

export class ImportPreviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(LIMITS.TITLE)
  fileName?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(IMPORT_MAX_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows!: ImportRowDto[];
}
