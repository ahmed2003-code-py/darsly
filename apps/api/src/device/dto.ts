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

/** Admin mints an enrollment code for the handset that will run the listener. */
export class MintEnrollmentCodeDto {
  @ApiProperty({ example: '01002589923' })
  @Matches(EGY_PHONE_REGEX, { message: 'phone must be a valid Egyptian mobile number' })
  phone: string;

  @ApiPropertyOptional({ example: 'موبايل الخزنة' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

/** The handset redeems that code. It never chooses its own phone number. */
export class DeviceEnrollDto {
  @ApiProperty({ example: 'K7QM-3XPD' })
  @IsString()
  @Length(8, 20)
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
  @MaxLength(4_096)
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
