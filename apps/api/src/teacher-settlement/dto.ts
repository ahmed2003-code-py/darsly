import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** One user action's identity: a retry or a double click reuses it. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
export const METHODS = ['PER_SESSION', 'PERCENT_OF_COLLECTIONS', 'FIXED_PERIOD'] as const;
export type PayMethod = (typeof METHODS)[number];

/* Who acted, when, statuses, versions, totals and the academy are the
 * server's: the global pipe refuses any other field (academyId, status,
 * grossCents, paidCents, finalizedBy, …) with a 400. Money is integer piasters. */

export class CreateAgreementDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsId() teacherUserId: string;
  @IsIn(METHODS) method: PayMethod;
  /** PER_SESSION: per class; FIXED_PERIOD: per calendar month. */
  @ValidateIf((o) => o.method !== 'PERCENT_OF_COLLECTIONS')
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  rateCents?: number;
  /** PERCENT_OF_COLLECTIONS: basis points, 1–10000. */
  @ValidateIf((o) => o.method === 'PERCENT_OF_COLLECTIONS')
  @IsInt()
  @Min(1)
  @Max(10_000)
  percentBps?: number;
  /** Required for PERCENT_OF_COLLECTIONS; optional for PER_SESSION (empty = all groups). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  groupIds?: string[];
  @Matches(DATE) effectiveFrom: string;
  @IsOptional() @Matches(DATE) effectiveTo?: string;
}

export class EndAgreementDto {
  /** The last day it applies. */
  @Matches(DATE) effectiveTo: string;
}

export class PeriodQuery {
  @IsId() teacherUserId: string;
  @Matches(DATE) from: string;
  @Matches(DATE) to: string;
}

export class FinalizeDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsId() teacherUserId: string;
  @Matches(DATE) from: string;
  @Matches(DATE) to: string;
  /** The gross the person reviewed: a different one now means the sources moved. */
  @IsInt() @Min(0) @Max(1_000_000_000) expectedGrossCents: number;
}

export class AdjustDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsIn(['BONUS', 'DEDUCTION', 'CORRECTION']) kind: 'BONUS' | 'DEDUCTION' | 'CORRECTION';
  /** Signed: a bonus is positive, a deduction negative, a correction either. */
  @IsInt() @Min(-100_000_000) @Max(100_000_000) amountCents: number;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class PayDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsInt() @Min(1) @Max(100_000_000) amountCents: number;
  @IsIn(['CASH', 'BANK_TRANSFER', 'OTHER']) method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(60) reference?: string;
}

export class VoidDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ListQuery {
  @IsOptional() @IsId() teacherUserId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}
