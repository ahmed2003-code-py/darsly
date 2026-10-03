import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** One user action's identity: a retry or a double click reuses it. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/* Who closed, when, the version and the figures are the server's: the global
 * pipe refuses any other field (academyId, version, figures, closedBy, …). */

export class DayQuery {
  @IsOptional() @Matches(DATE) date?: string;
}

export class CloseDayDto {
  @Matches(DATE) date: string;
  @Matches(REQUEST_KEY) requestKey: string;
  /** Required when the day has open items: what they are and why it closes anyway. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) exceptionNote?: string;
  /** Required when the day was closed before: why it is closed again. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(300) reason?: string;
}
