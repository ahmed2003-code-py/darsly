import { PartialType } from '@nestjs/swagger';
import { CoursePricingModel, CourseStatus, LessonType, CourseExamMode } from '@darsly/shared-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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
  // Which of the teacher's own subjects this course is. Optional because a
  // teacher who signed up for exactly one does not have to answer; the service
  // refuses a subject that is not theirs however the form is driven, the same
  // way it refuses a year they never signed up to teach.
  @IsOptional() @IsString() @MaxLength(LIMITS.ID) subjectId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(LIMITS.ID, { each: true })
  gradeIds?: string[];
  @IsOptional() @IsEnum(CoursePricingModel) pricingModel?: CoursePricingModel;
  /** integer piasters (1 EGP = 100) */
  @IsOptional() @IsInt() @Min(0) @Max(MAX_PRICE_CENTS) priceCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_WINDOW_DAYS) accessWindowDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) defaultViewsCap?: number;
}

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @IsOptional() @IsEnum(CourseStatus) status?: CourseStatus;
  /**
   * Which lesson is the course's exam, and which is its assignment.
   *
   * `null` unnames one. The lesson has to be in this course and of the right
   * type; both are checked on save rather than trusted, because the id arrives
   * from a browser.
   */
  @IsOptional() @IsOptionalId() examLessonId?: string | null;
  @IsOptional() @IsOptionalId() assignmentLessonId?: string | null;
  /**
   * What the exam is for: the paper at the end (`FINAL`, the default) or a
   * placement test the course stays shut behind (`GATE`).
   */
  @IsOptional() @IsEnum(CourseExamMode) examMode?: CourseExamMode;
}

export class UpsertUnitDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

export class CreateLessonDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.TITLE) title: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NOTE) description?: string;
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

/** Bulk-create lessons from YouTube links — one release/pricing setting for the whole batch. */
export class ImportYoutubeDto {
  // Small on purpose: each URL costs a real yt-dlp process (metadata now, a
  // full download in the background right after) — this is not a bulk-id list.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @IsString({ each: true }) @MaxLength(500, { each: true })
  urls: string[];

  /** Target section; omitted lands the lessons with no section, like a single direct add. */
  @IsOptionalId() unitId?: string;

  @IsOptional() @IsBoolean() isFreePreview?: boolean;
  @IsOptional() @IsISO8601() dripUnlockAt?: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_WINDOW_DAYS) dripAfterEnrollDays?: number;
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
