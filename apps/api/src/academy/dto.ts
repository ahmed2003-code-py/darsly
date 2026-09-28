import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
import { LIMITS } from '../common/validation';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class UpdateAcademyDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(160) tagline?: string;
  /**
   * The academy's public address: darsly.app/a/<slug>. Auto-generated on signup
   * (ae0011w), which is fine for a system and useless on a business card — a
   * teacher sharing their site wants their own name in it.
   *
   * Lower-case letters, digits and single hyphens; 3–40 characters. Uniqueness
   * and a reserved-word list are enforced in the service.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug may contain lower-case letters, digits and single hyphens only',
  })
  @MinLength(3)
  @MaxLength(40)
  slug?: string;

  // data URL or https. The service (`assertImage`) rejects anything that is
  // neither; the cap here keeps an oversized string out of the base64 decoder.
  @IsOptional() @IsString() @MaxLength(LIMITS.IMAGE_DATA_URL) logoUrl?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.IMAGE_DATA_URL) coverUrl?: string;
  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'colorPrimary must be a #RRGGBB hex' })
  colorPrimary?: string;
  @IsOptional()
  @IsString()
  @Matches(HEX, { message: 'colorAccent must be a #RRGGBB hex' })
  colorAccent?: string;
  @IsOptional() @IsIn(['ar', 'en']) language?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxConcurrentSessions?: number;
  @IsOptional() @IsIn(['AUTOMATIC', 'MANUAL', 'DEMO']) enrollmentMode?:
    'AUTOMATIC' | 'MANUAL' | 'DEMO';
  // Phase 7 (CENTER only): default share of a course's net that goes to its
  // teacher, 0–100. null clears it (paid Center courses stop being sellable).
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(100) teacherSharePercent?:
    number | null;
}

export class AddMemberDto {
  @IsEmail() email: string;
  @IsIn(['TEACHER', 'ASSISTANT']) role: 'TEACHER' | 'ASSISTANT';
}

/** The raw text a teacher typed into the address field, before normalizing. */
export class CheckSlugDto {
  @IsString() @MaxLength(120) value: string;
}

export class UpdateMemberDto {
  @IsOptional() @IsIn(['TEACHER', 'ASSISTANT']) role?: 'TEACHER' | 'ASSISTANT';
  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
  // Phase 7: this teacher's agreed share in the Center (overrides the Center default).
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(100) revenueSharePercent?:
    number | null;
  // Phase 7: grant/revoke the organisation's cash-collector capability.
  @IsOptional() @IsBoolean() canCollectCash?: boolean;
}

/**
 * What an assistant may do and where — exactly what the Team screen stores.
 * The preset the teacher started from is not part of it: presets only fill
 * these fields in the browser.
 */
export class AssistantGrantDto {
  @IsString() @MinLength(1) @MaxLength(40) title: string;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) permissions: string[];
  @IsIn(['ALL', 'SELECTED']) courseScope: 'ALL' | 'SELECTED';
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  courseIds: string[];
  @IsBoolean() directContact: boolean;
}

export class CreateInvitationLinkDto {
  @IsIn(['TEACHER', 'ASSISTANT'])
  role: 'TEACHER' | 'ASSISTANT';
  /** ASSISTANT only; an assistant link without one grants nothing until set on the Team screen. */
  @IsOptional() @ValidateNested() @Type(() => AssistantGrantDto) grant?: AssistantGrantDto;
}
