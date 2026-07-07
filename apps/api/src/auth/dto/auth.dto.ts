import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

// Egyptian mobile numbers: 010/011/012/015 + 8 digits, with optional +20/20/0020 prefix.
export const EGY_PHONE_REGEX = /^(\+20|0020|20|0)?1[0125][0-9]{8}$/;

export class RequestOtpDto {
  @ApiProperty({ example: '01012345678', description: 'Egyptian mobile number' })
  @IsString()
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '01012345678' })
  @IsString()
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiProperty({ example: '1234', description: '4-digit OTP code' })
  @IsString()
  @Length(4, 6)
  code: string;

  @ApiPropertyOptional({ example: 'أحمد محمود', description: 'Required on first login (signup)' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @ApiPropertyOptional({ example: 'Chrome on Android' })
  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class LoginPasswordDto {
  @ApiProperty({ example: 'admin@darsly.app', description: 'Email or phone' })
  @IsString()
  @IsNotEmpty()
  emailOrPhone: string;

  @ApiProperty({ example: 'Admin@12345' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ example: 'Chrome on Ubuntu' })
  @IsOptional()
  @IsString()
  deviceName?: string;
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
