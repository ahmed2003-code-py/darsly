import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsId } from '../common/validation';

/**
 * Who is at the desk: exactly one of a scanned card, a typed student code,
 * or a register record picked from the C1 search. The server decides what
 * that identifies — and derives the attendance method from which one it was
 * (card → QR, code → CODE, picked → MANUAL); no client says how.
 *
 * The global pipe refuses any field not declared here, so an academyId, a
 * status, a method, a checkedInAt or a token hash sent along is a 400.
 */
export class DeskIdentityDto {
  /** The QR's contents as scanned (digits; Arabic-Indic digits are accepted). */
  @IsOptional() @IsString() @MaxLength(80) token?: string;
  /** A C1 student code as typed. */
  @IsOptional() @IsString() @MaxLength(20) code?: string;
  /** An AcademyStudent id from the register search. */
  @IsOptional() @IsId() academyStudentId?: string;
}

export class DeskCheckInDto extends DeskIdentityDto {
  /**
   * The class. Absent means "the obvious one": the server checks in only
   * when there is exactly one class of theirs open now, and otherwise
   * answers with the choices (Rush mode never guesses).
   */
  @IsOptional() @IsId() sessionId?: string;
  /** The desk confirmed this is a makeup in someone else's class. */
  @IsOptional() @IsBoolean() makeup?: boolean;
  /** Makeup: which of their groups they come from, when they have several. */
  @IsOptional() @IsId() homeGroupId?: string;
  /** Makeup: the class of theirs this one makes up for. */
  @IsOptional() @IsId() makeupForSessionId?: string;
}

export const REVOKE_REASONS = ['LOST', 'DAMAGED', 'SECURITY', 'MANUAL', 'OTHER'] as const;
export const REISSUE_REASONS = ['LOST', 'DAMAGED', 'SECURITY', 'REISSUED', 'OTHER'] as const;

export class ReissueCardDto {
  /** The card being replaced, as the screen showed it: a stale screen gets CARD_CHANGED. */
  @IsId() cardId: string;
  @IsOptional() @IsIn(REISSUE_REASONS) reason?: (typeof REISSUE_REASONS)[number];
}

export class RevokeCardDto {
  @IsId() cardId: string;
  @IsIn(REVOKE_REASONS) reason: (typeof REVOKE_REASONS)[number];
}
