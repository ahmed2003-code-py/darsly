import { Type } from 'class-transformer';
import {
  IsBoolean,
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
} from 'class-validator';
import { IsId } from '../common/validation';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** One user action's identity: a retry or a double click reuses it. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const REASONS = [
  'ABSENT_TODAY',
  'ABSENT_STREAK',
  'LATE_STREAK',
  'FEES_OVERDUE',
  'MANUAL',
  'LOW_GRADE',
] as const;
export type Reason = (typeof REASONS)[number];
export const CHANNELS = ['PHONE_CALL', 'WHATSAPP', 'IN_PERSON', 'APP_MESSAGE', 'OTHER'] as const;
export const OUTCOMES = ['REACHED', 'NO_ANSWER', 'WRONG_NUMBER', 'MESSAGE_SENT', 'OTHER'] as const;
export const PARTIES = ['GUARDIAN_LINK', 'REGISTER_GUARDIAN', 'STUDENT', 'OTHER'] as const;

/*
 * Who acted, when, a case's status, its closing, the academy — all the
 * server's. The global pipe refuses any field not declared here (academyId,
 * openedBy, contactedBy, contactedAt, status, closedAt, …) with a 400.
 */

export class SignalsQuery {
  @IsOptional() @IsIn(REASONS.filter((r) => r !== 'MANUAL')) reason?: Exclude<Reason, 'MANUAL'>;
  /** Only learners nobody has contacted yet today. */
  @IsOptional() @IsIn(['1', 'true']) notContacted?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class OpenCaseDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsId() academyStudentId: string;
  @IsIn(REASONS) reason: Reason;
  /** The signal occurrence (from Today's signals); absent for a MANUAL case. */
  @ValidateIf((o) => o.reason !== 'MANUAL' || o.signalKey !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  signalKey?: string;
  /** Why, for a MANUAL case (required there); staff-only. */
  @ValidateIf((o) => o.reason === 'MANUAL' || o.note !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note?: string;
  @IsOptional() @IsId() assignedToUserId?: string;
  @IsOptional() @Matches(DATE) dueOn?: string;
}

export class AssignDto {
  /** null takes the case off anyone's list. */
  @ValidateIf((_, v) => v !== null) @IsId() assignedToUserId: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(DATE) dueOn?: string | null;
}

export class CloseDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class CasesQuery {
  @IsOptional() @IsIn(['OPEN', 'RESOLVED', 'DISMISSED']) status?: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  @IsOptional() @IsIn(['1', 'true']) mine?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class LogContactDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsIn(CHANNELS) channel: (typeof CHANNELS)[number];
  @IsIn(OUTCOMES) outcome: (typeof OUTCOMES)[number];
  @IsIn(PARTIES) party: (typeof PARTIES)[number];
  @ValidateIf((o) => o.party === 'GUARDIAN_LINK') @IsId() guardianLinkId?: string;
  @IsOptional() @IsId() followUpId?: string;
  /** Staff-only and bounded. Never logged, never shown to a guardian. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) note?: string;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class TimelineQuery {
  /** Events strictly before this instant (the previous page's cursor). */
  @IsOptional() @IsString() @MaxLength(40) before?: string;
}

export class SettingsDto {
  @IsOptional() @IsInt() @Min(2) @Max(10) absenceStreak?: number;
  @IsOptional() @IsInt() @Min(2) @Max(10) lateStreak?: number;
  @IsOptional() @IsInt() @Min(0) @Max(90) overdueDays?: number;
  @IsOptional() @IsBoolean() guardianFeesVisible?: boolean;
}
