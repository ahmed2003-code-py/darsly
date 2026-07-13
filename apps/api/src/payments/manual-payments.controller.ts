import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload, PaymentMethod, Role } from '@darsly/shared-types';
import { AcademyContext, CurrentAcademy } from '../academy/academy-context';
import { AcademyStaff } from '../academy/academy-staff.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ManualPaymentsService } from './manual-payments.service';
import { PaymentAccountsService, UpsertAccountDto } from './payment-accounts.service';

class SubmitPaymentDto {
  @IsString() courseId: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsString() @MaxLength(2_000_000) proofImageUrl: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() couponCode?: string;
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
  submit(@CurrentUser() u: JwtPayload, @Body() dto: SubmitPaymentDto) {
    return this.payments.submit(u.sub, dto);
  }

  @Get('payments/mine')
  @ApiBearerAuth()
  @Roles(Role.STUDENT)
  @ApiOperation({ summary: '[student] My payment submissions + status' })
  mine(@CurrentUser() u: JwtPayload) {
    return this.payments.myPayments(u.sub);
  }

  // ── Teacher verification ────────────────────────────────────────────────────

  @Get('teacher/payments')
  @AcademyStaff('payment.verify')
  @ApiOperation({ summary: '[academy] Payments to verify for this academy' })
  teacherQueue(@CurrentAcademy() ctx: AcademyContext, @Query('status') status?: string) {
    return this.payments.teacherQueue(ctx.academyId, status ?? 'PENDING');
  }

  @Post('teacher/payments/:id/verify')
  @AcademyStaff('payment.verify')
  @ApiOperation({ summary: '[academy] Confirm a payment → activates enrollment' })
  teacherVerify(@CurrentUser() u: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string) {
    // Authorize by the RESOLVED academy (owner or staff with payment.verify).
    return this.payments.verify({ sub: u.sub, role: Role.TEACHER, tenantId: ctx.academyId }, id);
  }

  @Post('teacher/payments/:id/reject')
  @AcademyStaff('payment.verify')
  @ApiOperation({ summary: '[academy] Reject a payment proof' })
  teacherReject(@CurrentUser() u: JwtPayload, @CurrentAcademy() ctx: AcademyContext, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.payments.reject({ sub: u.sub, role: Role.TEACHER, tenantId: ctx.academyId }, id, dto.reason);
  }

  // ── Admin oversight ─────────────────────────────────────────────────────────

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
