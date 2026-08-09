import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export const COURSE_SORTS = ['popular', 'rating', 'newest', 'priceAsc', 'priceDesc'] as const;
export type CourseSort = (typeof COURSE_SORTS)[number];

const toInt = ({ value }: { value: unknown }) => {
  if (value === '' || value == null) return undefined;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
};

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

/**
 * Student-facing course discovery.
 *
 * Every filter here resolves in SQL. The teacher directory does its price and
 * rating filtering in memory over the whole table, which is fine for a few
 * hundred teachers and would not be for a catalogue — a course list is the one
 * page that grows without bound.
 */
export class DiscoverCoursesDto {
  @ApiPropertyOptional({ description: 'Free-text search over course title, description and teacher name.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subjectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  gradeId?: string;

  @ApiPropertyOptional({ description: 'Teaching language of the teacher (ar / en).' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ description: 'Only this teacher\'s courses.' })
  @IsOptional()
  @IsString()
  teacherId?: string;

  /** Prices are in piasters, and are the academy's own price before the fee. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  priceMinCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  priceMaxCents?: number;

  @ApiPropertyOptional({ description: 'Only courses that cost nothing.' })
  @IsOptional()
  @Transform(toBool)
  free?: boolean;

  @ApiPropertyOptional({ description: 'Only courses with at least one free preview lesson.' })
  @IsOptional()
  @Transform(toBool)
  hasPreview?: boolean;

  @ApiPropertyOptional({ enum: COURSE_SORTS })
  @IsOptional()
  @IsIn(COURSE_SORTS)
  sort?: CourseSort;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10, description: 'Capped at 24.' })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
