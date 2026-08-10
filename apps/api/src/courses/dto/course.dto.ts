import { PartialType } from '@nestjs/swagger';
import { CoursePricingModel, CourseStatus, LessonType } from '@darsly/shared-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsOptionalId, IsPage, IsPageSize, LIMITS } from '../../common/validation';

/** ~10 years — anything longer is effectively "forever", which is `undefined`. */
const MAX_WINDOW_DAYS = 3_650;
/** A price ceiling in piasters: 1,000,000 EGP. Guards against a stray zero. */
const MAX_PRICE_CENTS = 100_000_000;

export class CreateCourseDto {
  @IsString() @MinLength(3) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.PROSE) description?: string;
  // URL or a client-resized base64 data URL (~600 KB cap). The shape (image
  // data-URL vs http(s), and the decoded byte size) is enforced by
  // `validateThumbnailUrl` in the service — this cap just stops an oversized
  // string from being decoded at all.
  @IsOptional() @IsString() @MaxLength(LIMITS.IMAGE_DATA_URL) thumbnailUrl?: string;
  @IsOptionalId() subjectId?: string;
  @IsOptionalId() gradeId?: string;
  @IsOptional() @IsEnum(CoursePricingModel) pricingModel?: CoursePricingModel;
  /** integer piasters (1 EGP = 100) */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE_CENTS) priceCents?: number;
  @IsOptional() @IsBoolean() requiresEnrollmentApproval?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_WINDOW_DAYS) accessWindowDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) defaultViewsCap?: number;
}

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @IsOptional() @IsEnum(CourseStatus) status?: CourseStatus;
}

export class UpsertUnitDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

export class CreateLessonDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsEnum(LessonType) type?: LessonType;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
  // A 24-hour lesson is already absurd; the cap keeps a typo out of progress maths.
  @IsOptional() @IsInt() @Min(0) @Max(86_400) durationSec?: number;
  @IsOptional() @IsBoolean() isFreePreview?: boolean;
  /** Content drip: unlock at a fixed date… */
  @IsOptional() @IsISO8601() dripUnlockAt?: string;
  /** …or N days after the student enrolls. */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_WINDOW_DAYS) dripAfterEnrollDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) viewsCap?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_WINDOW_DAYS) accessWindowDays?: number;
  @IsOptionalId() videoAssetId?: string;
}

export class UpdateLessonDto extends PartialType(CreateLessonDto) {
  /** set true to clear the drip schedule */
  @IsOptional() @IsBoolean() clearDrip?: boolean;
}

export class ReorderDto {
  /** ids in their new order */
  @IsArray() @ArrayMaxSize(LIMITS.ARRAY) @ArrayUnique()
  @IsString({ each: true }) @MaxLength(LIMITS.ID, { each: true })
  ids: string[];
}

export class SetBundleItemsDto {
  @IsArray() @ArrayMaxSize(LIMITS.ARRAY) @ArrayUnique()
  @IsString({ each: true }) @MaxLength(LIMITS.ID, { each: true })
  courseIds: string[];
}

export class PaginationDto {
  @Type(() => Number) @IsPage() page?: number;
  @Type(() => Number) @IsPageSize() pageSize?: number;
}
