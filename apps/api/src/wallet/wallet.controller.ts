import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LIMITS } from '../common/validation';
import { WalletService } from './wallet.service';

class SubmitTopupDto {
  @IsInt() @Min(1_000) @Max(5_000_000) amountCents: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsString() @MaxLength(LIMITS.PROOF_DATA_URL) proofImageUrl: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}
class RejectDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

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
  submitTopup(@CurrentUser() u: JwtPayload, @Body() dto: SubmitTopupDto) {
    return this.wallet.submitTopup(u.sub, dto);
  }

  @Get('wallet/topups/mine')
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My top-up requests + status' })
  myTopups(@CurrentUser() u: JwtPayload) {
    return this.wallet.myTopups(u.sub);
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
