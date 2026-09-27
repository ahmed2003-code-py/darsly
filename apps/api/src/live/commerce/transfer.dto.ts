import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const TRANSFER_METHODS = ['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER'] as const;
const SOURCES = ['WALLET', 'BANK'] as const;

/**
 * Before the transfer: which Darsly account the money goes TO (method), and
 * where it comes FROM (source) — a wallet (its number) or a bank / InstaPay
 * account (its holder's name). Nothing about money: the amount is the
 * purchase's frozen price.
 */
export class DeclareTransferDto {
  @IsIn(TRANSFER_METHODS) method: (typeof TRANSFER_METHODS)[number];
  @IsIn(SOURCES) source: (typeof SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(20) senderWallet?: string;
  @IsOptional() @IsString() @MaxLength(80) payerName?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

/**
 * After the transfer: the proof. The identity fields are accepted only from a
 * client that never declared (it then declares and claims in one step).
 */
export class TransferClaimBodyDto {
  @IsOptional() @IsIn(TRANSFER_METHODS) method?: (typeof TRANSFER_METHODS)[number];
  @IsOptional() @IsIn(SOURCES) source?: (typeof SOURCES)[number];
  @IsOptional() @IsString() @MaxLength(20) senderWallet?: string;
  @IsOptional() @IsString() @MaxLength(80) payerName?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  // A client-resized screenshot as a data URL; the storage layer caps its size.
  @IsOptional() @IsString() @MaxLength(3_000_000) proofImageUrl?: string;
}

/** Why an admin is acting — stored in the audit log with their id. */
export class AdminReasonDto {
  @IsString() @MaxLength(300) reason: string;
}
