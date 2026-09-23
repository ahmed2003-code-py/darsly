import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsId, LIMITS } from '../../common/validation';

export class CreateRoomDto {
  @IsString() @MinLength(1) @MaxLength(LIMITS.NAME) name: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) location?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
}

export class UpdateRoomDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(LIMITS.NAME) name?: string;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) location?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) capacity?: number;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class CreateSessionDto {
  @IsOptional() @IsId() roomId?: string;
  @IsOptional() @IsId() teacherUserId?: string;
  /** ISO 8601 instant — the frontend sends a UTC instant it has already
   *  converted from the academy's local (Cairo) picker; see period.util.ts. */
  @IsISO8601() startAt: string;
  @IsISO8601() endAt: string;
  @IsOptional() @IsIn(['ONLINE', 'PHYSICAL', 'HYBRID']) mode?: 'ONLINE' | 'PHYSICAL' | 'HYBRID';
  @IsOptional() @IsIn(['CENTER', 'TEACHER', 'STUDENT', 'OTHER', null]) locationType?:
    'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) locationNote?: string | null;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?:
    string | null;
}

export class UpdateSessionDto {
  @IsOptional() @IsId() roomId?: string;
  @IsOptional() @IsId() teacherUserId?: string;
  @IsOptional() @IsISO8601() startAt?: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsOptional() @IsIn(['SCHEDULED', 'CANCELLED', 'COMPLETED']) status?:
    'SCHEDULED' | 'CANCELLED' | 'COMPLETED';
  @IsOptional() @IsIn(['ONLINE', 'PHYSICAL', 'HYBRID']) mode?: 'ONLINE' | 'PHYSICAL' | 'HYBRID';
  @IsOptional() @IsIn(['CENTER', 'TEACHER', 'STUDENT', 'OTHER', null]) locationType?:
    'CENTER' | 'TEACHER' | 'STUDENT' | 'OTHER' | null;
  @IsOptional() @IsString() @MaxLength(LIMITS.NAME) locationNote?: string | null;
  @IsOptional() @IsUrl({ protocols: ['http', 'https'] }) @MaxLength(LIMITS.URL) joinUrl?:
    string | null;
}
