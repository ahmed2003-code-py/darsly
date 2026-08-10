import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { IsId, LIMITS } from '../common/validation';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentAccountsService, UpsertAccountDto } from './payment-accounts.service';
import { PaymentMatchingService } from './payment-matching.service';

class SubmitPaymentDto {
  @IsId() courseId: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  // A receipt photo as a base64 data URL. Bigger than the other image caps on
  // purpose: an unreadable receipt cannot be verified.
  @IsString() @MaxLength(LIMITS.PROOF_DATA_URL) proofImageUrl: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(24) couponCode?: string;
}
class RejectDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class AccountDto {
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsString() @MinLength(2) @MaxLength(80) label: string;
  @IsString() @MinLength(3) @MaxLength(120) handle: string;
  @IsOptional() @IsString() @MaxLength(400) instructions?: string;
}

@ApiTags('payments')
@Controller()
export class ManualPaymentsController {
  constructor(
    private readonly payments: ManualPaymentsService,
    private readonly accounts: PaymentAccountsService,
    private readonly matching: PaymentMatchingService,
  ) {}

  // ── Receiving accounts ──────────────────────────────────────────────────────

  @Get('payment-accounts')
  @Public()
  @ApiOperation({ summary: 'Active accounts to transfer money to' })
  publicAccounts() {
    return this.accounts.listPublic();
  }

  // ── Student ─────────────────────────────────────────────────────────────────

  @Post('payments')
  @ApiBearerAuth()
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] Submit a proof of payment for a course' })
  async submit(@CurrentUser() u: JwtPayload, @Body() dto: SubmitPaymentDto) {
    const payment = await this.payments.submit(u.sub, dto);
    // Students transfer first and fill the form afterwards, so the wallet SMS has
    // usually already arrived and is sitting unmatched. Check for it now rather
    // than leaving a payment waiting on a human for a transfer we already have.
    // Never let a reconciliation failure fail the submission itself.
    const reconciled = await this.matching
      .reconcilePayment(payment.id)
      .catch(() => ({ status: 'SKIPPED' as const }));
    return { ...payment, autoVerified: reconciled.status === 'MATCHED' };
  }

  @Get('payments/mine')
  @ApiBearerAuth()
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My payment submissions + status' })
  mine(@CurrentUser() u: JwtPayload) {
    return this.payments.myPayments(u.sub);
  }

  // ── Academy (read-only) ─────────────────────────────────────────────────────
  //
  // Verifying a payment is deliberately NOT a teacher capability. Confirming a
  // transfer moves money: it credits the academy's own balance and books the
  // platform's fee. Letting the party that gets paid also decide that it was paid
  // is the wrong control, and it is no longer needed — a real transfer is
  // confirmed by the listener against the wallet SMS, and anything the matcher
  // cannot confirm goes to a platform admin.
  //
  // Teachers keep full visibility of their queue; they just cannot approve it.

  @Get('teacher/payments')
  @AcademyStaff('payment.verify')
  @ApiOperation({ summary: '[academy] Payments for this academy (read-only)' })
  teacherQueue(@CurrentAcademy() ctx: AcademyContext, @Query('status') status?: string) {
    return this.payments.teacherQueue(ctx.academyId, status ?? 'PENDING');
  }

  @Get('admin/payments')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] All manual payments' })
  adminQueue(@Query('status') status?: string) {
    return this.payments.adminQueue(status ?? 'PENDING');
  }

  @Post('admin/payments/:id/verify')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Confirm any payment' })
  adminVerify(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.payments.verify(u, id);
  }

  @Post('admin/payments/:id/reject')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Reject any payment' })
  adminReject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.payments.reject(u, id, dto.reason);
  }

  /**
   * Re-run matching over everything still pending.
   *
   * Reconciliation normally happens the moment a payment is submitted, but a
   * payment made before that existed — or while the matcher had a bug — is stuck
   * with its transfer sitting unmatched beside it. This replays the same
   * evidence-based rules over those pairs; it never verifies anything the matcher
   * would not have verified on its own.
   */
  @Post('admin/payments/reconcile')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Re-match pending payments against unmatched transfers' })
  async reconcileAll() {
    const pending = await this.payments.adminQueue('PENDING');
    const results = [];
    for (const payment of pending) {
      const outcome = await this.matching
        .reconcilePayment(payment.id)
        .catch(() => ({ status: 'ERROR' as const }));
      results.push({ paymentId: payment.id, amountCents: payment.amountCents, status: outcome.status });
    }
    return {
      checked: results.length,
      matched: results.filter((r) => r.status === 'MATCHED').length,
      results,
    };
  }

  @Post('admin/payments/:id/settle')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Settle a self-verified payment → credits withdrawable balance' })
  adminSettle(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.payments.settle(id, u.sub);
  }

  // ── Admin: manage receiving accounts ────────────────────────────────────────

  @Get('admin/payment-accounts')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] All receiving accounts' })
  allAccounts() {
    return this.accounts.listAll();
  }

  @Post('admin/payment-accounts')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Add a receiving account' })
  createAccount(@Body() dto: AccountDto) {
    return this.accounts.create(dto as UpsertAccountDto);
  }

  @Patch('admin/payment-accounts/:id')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Edit a receiving account (incl. isActive)' })
  updateAccount(@Param('id') id: string, @Body() dto: Partial<UpsertAccountDto>) {
    return this.accounts.update(id, dto);
  }

  @Delete('admin/payment-accounts/:id')
  @ApiBearerAuth()
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '[admin] Delete a receiving account' })
  deleteAccount(@Param('id') id: string) {
    return this.accounts.remove(id);
  }
}
