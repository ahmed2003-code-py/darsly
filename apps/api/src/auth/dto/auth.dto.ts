import { BadRequestException } from '@nestjs/common';
import { LIMITS } from '../../common/validation';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Kept in step with the `EducationStage` enum in the schema. */
export const EDUCATION_STAGES = ['PRIMARY', 'PREPARATORY', 'SECONDARY', 'BACCALAUREATE'] as const;
export type EducationStageValue = (typeof EDUCATION_STAGES)[number];

/**
 * The `SubjectTrack` values a student can be. `BOTH` is deliberately absent:
 * it describes a subject every student sits, not a school anyone attends.
 */
export const STUDENT_TRACKS = ['GENERAL', 'LANGUAGES'] as const;
export type StudentTrackValue = (typeof STUDENT_TRACKS)[number];

// Egyptian mobile numbers: 010/011/012/015 + 8 digits, with optional +20/20/0020 prefix.
export const EGY_PHONE_REGEX = /^(\+20|0020|20|0)?1[0125][0-9]{8}$/;

// A strong-enough password: ≥8 chars with at least one letter and one digit.
export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
const PASSWORD_MSG = 'Password must be at least 8 characters and include a letter and a number';

// A username starts with a letter so it can never be read as a phone number,
// and has no "@" so it can never be read as an email. 3–30 chars.
export const USERNAME_REGEX = /^[a-z][a-z0-9_]{2,29}$/i;
const USERNAME_MSG = 'Username must be 3–30 characters: letters, digits or _, starting with a letter';

export class LoginDto {
  /**
   * Email, Egyptian mobile number, or username — the server works out which.
   * `email` stays accepted so a tab open across a deploy keeps working.
   */
  @ApiPropertyOptional({ example: 'student1@darsly.app' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  identifier?: string;

  @ApiPropertyOptional({ example: 'student1@darsly.app', deprecated: true })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  email?: string;

  @ApiProperty({ example: 'Student@12345' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({ example: 'Chrome on Ubuntu' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

export class RegisterStudentDto {
  @ApiProperty({ example: 'ahmed@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: 'أحمد محمود' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password: string;

  @ApiProperty({ example: '01012345678' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiPropertyOptional({ example: 'ahmed_m' })
  @IsOptional()
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  username?: string;

  // Asked at sign-up because it decides what the whole app shows them. Without
  // it a student's first screen is every teacher on the platform, most of whom
  // teach years they are not in.
  @ApiProperty({ example: 'clx123gradeid' })
  @IsString()
  @IsNotEmpty({ message: 'Pick the year you are in' })
  gradeId: string;

  // Which school system they are in, asked for the same reason as the year:
  // a language-school student and a national-system one sit different syllabi
  // under the same subject name, and showing each of them the other's teachers
  // is showing them courses they cannot use.
  @ApiProperty({ example: 'GENERAL', enum: STUDENT_TRACKS })
  @IsIn(STUDENT_TRACKS, { message: 'Pick whether you are in a general or a language school' })
  track: StudentTrackValue;

  @ApiPropertyOptional({ example: 'Chrome on Android' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

export class RegisterTeacherDto {
  @ApiProperty({ example: 'teacher@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: 'أ. خالد حسن' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password: string;

  @ApiProperty({ example: '01012345678' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiPropertyOptional({ example: 'mr_khaled' })
  @IsOptional()
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  username?: string;

  @ApiPropertyOptional({ example: 'مدرس رياضيات بخبرة 10 سنوات' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  bio?: string;

  // Asked for at sign-up rather than left to a settings page nobody visits.
  // Every course this teacher creates is offered inside these answers, so a
  // blank profile would leave them unable to publish anything findable.
  // A set, not one: a maths teacher usually takes both school systems, and
  // being asked to pick one of them hid them from half the students they teach.
  @ApiProperty({ example: ['clx123subjectid'], isArray: true })
  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one subject you teach' })
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(LIMITS.ID, { each: true })
  subjectIds: string[];

  @ApiProperty({ example: ['SECONDARY', 'BACCALAUREATE'], enum: EDUCATION_STAGES, isArray: true })
  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one stage you teach' })
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(EDUCATION_STAGES, { each: true })
  stages: EducationStageValue[];
}

/**
 * Account creation for someone a Center invited by link. Deliberately carries
 * NO role, NO academy and NO owner: the token names all three and the server
 * reads them from the stored row. Subjects/stages are what a TEACHER invitee
 * will author under and are required for that role only — the service, not
 * this shape, decides, because the shape cannot see the token's role.
 */
export class RegisterViaInvitationDto {
  @ApiProperty({ example: 'NdAWTeObUi2NUYNi5hwwErzIrlq33IsExIVC-wAFl4E' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token: string;

  @ApiProperty({ example: 'teacher@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: 'أ. خالد حسن' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password: string;

  @ApiProperty({ example: '01012345678' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiPropertyOptional({ example: 'mr_khaled' })
  @IsOptional()
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  username?: string;

  @ApiPropertyOptional({ example: ['clx123subjectid'], isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(LIMITS.ID, { each: true })
  subjectIds?: string[];

  @ApiPropertyOptional({ example: ['SECONDARY'], enum: EDUCATION_STAGES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(EDUCATION_STAGES, { each: true })
  stages?: EducationStageValue[];

  @ApiPropertyOptional({ example: 'Chrome on Android' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'OldPassw0rd' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ example: 'NewPassw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  newPassword: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ahmed@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;
}

/** The 6-digit code emailed by `forgot-password`. */
const RESET_CODE_REGEX = /^[0-9]{6}$/;
const RESET_CODE_MSG = 'code must be the 6-digit number sent to your email';

export class VerifyResetCodeDto {
  @ApiProperty({ example: 'ahmed@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: '482913' })
  @Matches(RESET_CODE_REGEX, { message: RESET_CODE_MSG })
  code: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'ahmed@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: '482913' })
  @Matches(RESET_CODE_REGEX, { message: RESET_CODE_MSG })
  code: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password: string;
}

/** The one-time link a newly designated Center Admin follows to set a password. */
export class ActivateAccountDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token: string;

  @ApiProperty({ example: 'Passw0rd!' })
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/**
 * Normalize any accepted Egyptian format to E.164 (+2010xxxxxxxx).
 *
 * Throws a 400, not a bare Error: callers reach this with values that skipped
 * DTO validation (the device-enrollment service takes a phone from an operator),
 * and a malformed number there is bad input, not a server fault.
 */
export function normalizeEgyptianPhone(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  const match = digits.match(/^(?:\+20|0020|20|0)?(1[0125][0-9]{8})$/);
  if (!match) {
    throw new BadRequestException({
      message: 'phone must be a valid Egyptian mobile number',
      code: 'INVALID_PHONE',
    });
  }
  return `+20${match[1]}`;
}
