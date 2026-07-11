import { PartialType } from '@nestjs/swagger';
import { CoursePricingModel, CourseStatus, LessonType } from '@darsly/shared-types';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCourseDto {
  @IsString() @MinLength(3) title: string;
  @IsOptional() @IsString() description?: string;
  // URL or a client-resized base64 data URL (~600 KB cap).
  @IsOptional() @IsString() @MaxLength(900_000) thumbnailUrl?: string;
  @IsOptional() @IsString() subjectId?: string;
  @IsOptional() @IsString() gradeId?: string;
  @IsOptional() @IsEnum(CoursePricingModel) pricingModel?: CoursePricingModel;
  /** integer piasters (1 EGP = 100) */
  @IsOptional() @IsInt() @Min(0) priceCents?: number;
  @IsOptional() @IsBoolean() requiresEnrollmentApproval?: boolean;
  @IsOptional() @IsInt() @Min(1) accessWindowDays?: number;
  @IsOptional() @IsInt() @Min(1) defaultViewsCap?: number;
}

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @IsOptional() @IsEnum(CourseStatus) status?: CourseStatus;
}

export class UpsertUnitDto {
  @IsString() @MinLength(1) title: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class CreateLessonDto {
  @IsString() @MinLength(1) title: string;
  @IsOptional() @IsEnum(LessonType) type?: LessonType;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsInt() @Min(0) durationSec?: number;
  @IsOptional() @IsBoolean() isFreePreview?: boolean;
  /** Content drip: unlock at a fixed date… */
  @IsOptional() @IsISO8601() dripUnlockAt?: string;
  /** …or N days after the student enrolls. */
  @IsOptional() @IsInt() @Min(0) dripAfterEnrollDays?: number;
  @IsOptional() @IsInt() @Min(1) viewsCap?: number;
  @IsOptional() @IsInt() @Min(1) accessWindowDays?: number;
  @IsOptional() @IsString() videoAssetId?: string;
}

export class UpdateLessonDto extends PartialType(CreateLessonDto) {
  /** set true to clear the drip schedule */
  @IsOptional() @IsBoolean() clearDrip?: boolean;
}

export class ReorderDto {
  /** ids in their new order */
  @IsArray() @ArrayUnique() @IsString({ each: true }) ids: string[];
}

export class SetBundleItemsDto {
  @IsArray() @ArrayUnique() @IsString({ each: true }) courseIds: string[];
}

export class PaginationDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}
