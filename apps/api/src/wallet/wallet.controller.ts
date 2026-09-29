import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LIMITS } from '../common/validation';
import { PaymentMatchingService } from '../payments/payment-matching.service';
import { WalletService } from './wallet.service';

class SubmitTopupDto {
  @IsInt() @Min(1_000) @Max(5_000_000) amountCents: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsString() @MaxLength(LIMITS.PROOF_DATA_URL) proofImageUrl: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}
class DeclareTopupDto {
  @IsInt() @Min(1_000) @Max(5_000_000) amountCents: number;
  @IsIn(['INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER']) method:
    'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  @IsIn(['WALLET', 'BANK']) source: 'WALLET' | 'BANK';
  @IsOptional() @IsString() @MaxLength(20) senderWallet?: string;
  @IsOptional() @IsString() @MaxLength(80) payerName?: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}
class TopupProofDto {
  @IsString() @MaxLength(LIMITS.PROOF_DATA_URL) proofImageUrl: string;
}
class RejectDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@Controller()
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly matching: PaymentMatchingService,
  ) {}

  // ── Student ─────────────────────────────────────────────────────────────────

  @Get('wallet')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Wallet balance + recent transactions + pending top-ups' })
  myWallet(@CurrentUser() u: JwtPayload) {
    return this.wallet.myWallet(u.sub);
  }

  @Post('wallet/topups')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Request a wallet top-up with a transfer proof' })
  async submitTopup(@CurrentUser() u: JwtPayload, @Body() dto: SubmitTopupDto) {
    const topup = await this.wallet.submitTopup(u.sub, dto);
    // The transfer is nearly always already sitting here, filed UNMATCHED,
    // because students send the money before they fill the form. Looking now is
    // what turns "pending until an admin notices" into a credited balance.
    // The wallet screen re-reads its status either way, so a failure here costs
    // the student nothing beyond the wait they had before.
    const reconciled = await this.matching.reconcileTopup(topup.id).catch(() => null);
    return { ...topup, autoApproved: reconciled?.status === 'MATCHED' };
  }

  /**
   * The Live flow, for a top-up: declare BEFORE transferring. The PENDING
   * top-up exists before Darsly's account is shown; an SMS already here is
   * decided at once, and a later one credits it by itself.
   */
  @Post('wallet/topups/declare')
  @Roles(Role.STUDENT)
  @ApiOperation({
    summary: '[student] Declare a top-up transfer (creates the PENDING top-up before the transfer)',
  })
  async declareTopup(@CurrentUser() u: JwtPayload, @Body() dto: DeclareTopupDto) {
    const t = await this.wallet.declareTopup(u.sub, dto);
    await this.matching.reconcileTopup(t.id).catch(() => undefined);
    return this.wallet.topupStatus(u.sub, t.id);
  }

  @Get('wallet/topups/mine')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My top-up requests + status' })
  myTopups(@CurrentUser() u: JwtPayload) {
    return this.wallet.myTopups(u.sub);
  }

  @Get('wallet/topups/open')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My open top-up, if any (to resume it)' })
  openTopup(@CurrentUser() u: JwtPayload) {
    return this.wallet.openTopup(u.sub);
  }

  @Get('wallet/topups/:id')
  @Roles(Role.STUDENT)
  @ApiOperation({
    summary: '[student] Where my top-up stands, and my balance (the wallet screen polls this)',
  })
  topupStatus(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.wallet.topupStatus(u.sub, id);
  }

  @Post('wallet/topups/:id/proof')
  @Roles(Role.STUDENT)
  @ApiOperation({
    summary: '[student] Attach the transfer receipt (supporting evidence) to my declared top-up',
  })
  async topupProof(
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Body() dto: TopupProofDto,
  ) {
    await this.wallet.attachTopupProof(u.sub, id, dto.proofImageUrl);
    await this.matching.reconcileTopup(id).catch(() => undefined);
    return this.wallet.topupStatus(u.sub, id);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  @Get('admin/wallet/topups')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Wallet top-up requests' })
  adminTopups(@Query('status') status?: string) {
    return this.wallet.adminTopups(status ?? 'PENDING');
  }

  @Post('admin/wallet/topups/:id/approve')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Confirm a transfer → credit the wallet' })
  approve(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.wallet.approveTopup(u.sub, id);
  }

  @Post('admin/wallet/topups/:id/reject')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Reject a wallet top-up' })
  reject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.wallet.rejectTopup(u.sub, id, dto.reason);
  }
}
