import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  ValidateNested,
} from 'class-validator';
import { IsId } from '../common/validation';
import { MAX_CENTS } from './money';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** One user action's identity: a retry or a double click reuses it. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/*
 * Amounts are integer minor units (piasters). The currency is the academy's
 * and is never sent. Who, when, the receipt number, a status, a balance or a
 * reversal are the server's; the global pipe refuses any field not declared
 * here (academyId, receivedBy, receivedAt, receiptNumber, balanceAfterCents,
 * reversedAt, createdBy, currency …) with a 400.
 */

export class CreatePlanDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsId() groupId: string;
  @IsIn(['MONTHLY', 'PER_SESSION']) type: 'MONTHLY' | 'PER_SESSION';
  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;
  /** MONTHLY: the day a month's fee falls due (1–28). */
  @IsOptional() @IsInt() @Min(1) @Max(28) dueDay?: number;
  /** First local date charged; today when absent, never earlier. */
  @IsOptional() @Matches(DATE) startsOn?: string;
}

export class UpdatePlanDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  /** Applies to charges posted from now on; posted charges keep their amount. */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_CENTS) amountCents?: number;
  @IsOptional() @IsInt() @Min(1) @Max(28) dueDay?: number;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
}

export class OneTimeChargeDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsString() @MinLength(1) @MaxLength(120) description: string;
  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;
  @Matches(DATE) dueOn: string;
}

export class MonthlyForStudentDto {
  @IsId() planId: string;
}

export class AllocationDto {
  @IsId() chargeId: string;
  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;
}

export class CollectDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;
  @IsIn(['CASH', 'CARD_EXTERNAL', 'BANK_TRANSFER', 'OTHER'])
  method: 'CASH' | 'CARD_EXTERNAL' | 'BANK_TRANSFER' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  /** Which charges, how much each; absent = oldest due first. Must add up to the amount. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

export class PreviewDto {
  @IsInt() @Min(1) @Max(MAX_CENTS) amountCents: number;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

export class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class AdjustDto {
  @Matches(REQUEST_KEY) requestKey: string;
  @IsIn(['DISCOUNT', 'CORRECTION']) kind: 'DISCOUNT' | 'CORRECTION';
  /** An amount off (DISCOUNT) or by which to correct (CORRECTION)… */
  @IsOptional() @IsInt() @Min(1) @Max(MAX_CENTS) amountCents?: number;
  /** …or, for a DISCOUNT only, a percentage of the posted amount in basis points. */
  @IsOptional() @IsInt() @Min(1) @Max(10_000) percentBps?: number;
  /** CORRECTION only: whether it raises or lowers what is owed. */
  @IsOptional() @IsIn(['INCREASE', 'DECREASE']) direction?: 'INCREASE' | 'DECREASE';
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class OutstandingQuery {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional()
  @IsIn(['OWING', 'OVERDUE', 'PARTIAL', 'PAID', 'ALL'])
  status?: 'OWING' | 'OVERDUE' | 'PARTIAL' | 'PAID' | 'ALL';
  @IsOptional() @IsId() groupId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}

export class DayQuery {
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}
