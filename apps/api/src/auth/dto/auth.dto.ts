import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// Egyptian mobile numbers: 010/011/012/015 + 8 digits, with optional +20/20/0020 prefix.
export const EGY_PHONE_REGEX = /^(\+20|0020|20|0)?1[0125][0-9]{8}$/;

// A strong-enough password: ≥8 chars with at least one letter and one digit.
export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
const PASSWORD_MSG = 'Password must be at least 8 characters and include a letter and a number';

export class LoginDto {
  @ApiProperty({ example: 'student1@darsly.app' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;

  @ApiProperty({ example: 'Student@12345' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({ example: 'Chrome on Ubuntu' })
  @IsOptional()
  @IsString()
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

  @ApiPropertyOptional({ example: '01012345678' })
  @IsOptional()
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone?: string;

  @ApiPropertyOptional({ example: 'Chrome on Android' })
  @IsOptional()
  @IsString()
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

  @ApiPropertyOptional({ example: 'مدرس رياضيات بخبرة 10 سنوات' })
  @IsOptional()
  @IsString()
  @MaxLength(600)
  bio?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ahmed@example.com' })
  @IsEmail({}, { message: 'A valid email is required' })
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
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

/** Normalize any accepted Egyptian format to E.164 (+2010xxxxxxxx). */
export function normalizeEgyptianPhone(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  const match = digits.match(/^(?:\+20|0020|20|0)?(1[0125][0-9]{8})$/);
  if (!match) throw new Error(`Invalid Egyptian phone: ${raw}`);
  return `+20${match[1]}`;
}
