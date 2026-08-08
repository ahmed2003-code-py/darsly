import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { EGY_PHONE_REGEX } from '../auth/dto/auth.dto';

export class DeviceRequestOtpDto {
  @ApiProperty({ example: '01012345678' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;
}

export class DeviceVerifyOtpDto {
  @ApiProperty({ example: '01012345678' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiProperty({ example: '0000' })
  @IsString()
  @Length(4, 8)
  code: string;

  @ApiPropertyOptional({ example: 'Pixel 7' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;
}

export class DeviceRefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}

/**
 * A single received SMS from the device outbox. The app sends the raw body and
 * its locally-parsed hints; the backend re-derives money-affecting fields from
 * `message` before it can forward/auto-verify.
 */
export class DeviceSmsEventDto {
  @ApiProperty({ example: 'CIB' })
  @IsString()
  @MaxLength(64)
  sender: string;

  @ApiProperty({ example: 'Your account was credited with EGP 5,000. Ref 884213' })
  @IsString()
  @MaxLength(2000)
  message: string;

  @ApiProperty({ example: '2026-08-08T06:12:00Z' })
  @IsISO8601()
  receivedAt: string;

  @ApiProperty({
    example: 'a1b2…',
    description: 'SHA-256(normalizedSender + " " + body + " " + receivedAtEpochSec)',
  })
  @IsString()
  @Length(16, 128)
  messageHash: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  simSlot?: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  subscriptionId?: number;
}
