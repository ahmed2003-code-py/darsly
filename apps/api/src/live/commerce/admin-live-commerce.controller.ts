import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LivePurchaseStatus } from '@prisma/client';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveCommerceService } from './live-commerce.service';
import { UnmatchedTransfersService } from '../../payments/unmatched-transfers.service';
import { AdminReasonDto } from './transfer.dto';

const STATUSES = new Set<string>(Object.values(LivePurchaseStatus));

class AdminRefundDto {
  @IsOptional() @IsIn(['ADMIN', 'NO_SHOW']) reason?: 'ADMIN' | 'NO_SHOW';
}

class CompleteRefundDto {
  @IsString() @MaxLength(120) transferReference: string;
}

class RejectRefundDto {
  @IsString() @MaxLength(500) reason: string;
}

/**
 * Darsly finance's view of Live sales: every purchase with its full frozen
 * split, and the two decisions only a person makes — release a reviewed
 * purchase's earnings, or refund it. Platform admin only; a teacher or a
 * Center never reaches these routes.
 */
@ApiTags('admin/live-commerce')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin/live-commerce')
export class AdminLiveCommerceController {
  constructor(
    private readonly commerce: LiveCommerceService,
    private readonly prisma: PrismaService,
    private readonly transfers: UnmatchedTransfersService,
  ) {}

  @Get('transfers/:eventId/candidates')
  @ApiOperation({ summary: '[admin] Where an unmatched transfer could go: pending payments, and Live purchases with no payment' })
  async transferCandidates(@Param('eventId') eventId: string) {
    const e = await this.transfers.event(eventId);
    const [payments, purchases] = await Promise.all([
      this.transfers.paymentCandidates(eventId),
      this.commerce.recoveryCandidates(e.amountCents),
    ]);
    return { amountCents: e.amountCents, provider: e.provider, status: e.status, payments, purchases };
  }

  @Post('transfers/:eventId/attach/:purchaseId')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Recovery: turn an unmatched transfer into this purchase’s payment, then verify normally' })
  attach(
    @CurrentUser() u: JwtPayload,
    @Param('eventId') eventId: string,
    @Param('purchaseId') purchaseId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.commerce.adminAttachTransfer(eventId, purchaseId, u.sub, dto.reason);
  }

  @Get('purchases')
  @ApiOperation({ summary: '[admin] Live purchases with their frozen split (filter by status/session)' })
  async purchases(@Query('status') status?: string, @Query('sessionId') sessionId?: string) {
    const rows = await this.prisma.livePurchase.findMany({
      where: {
        ...(status && STATUSES.has(status) ? { status: status as LivePurchaseStatus } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        session: { select: { title: true, startsAt: true, durationMin: true, status: true, startedAt: true, endedAt: true } },
        student: { select: { user: { select: { fullName: true, phone: true } } } },
        guestBuyer: { select: { displayName: true } },
        payment: { select: { id: true, status: true, method: true, paidAt: true, claimedAt: true, walletCents: true } },
        refunds: true,
      },
    });
    return rows.map((p) => ({
      id: p.id,
      status: p.status,
      reviewReason: p.reviewReason,
      session: p.session,
      sessionId: p.sessionId,
      academyId: p.academyId,
      buyerName: p.student?.user.fullName ?? p.guestBuyer?.displayName ?? null,
      guest: !!p.guestBuyerId,
      buyerPhone: p.student?.user.phone ?? null,
      currency: p.currency,
      basePriceCents: p.basePriceCents,
      discountCents: p.discountCents,
      feeType: p.feeType,
      feeMode: p.feeMode,
      feeBps: p.feeBps,
      feeFixedCents: p.feeFixedCents,
      feeCents: p.feeCents,
      studentPaysCents: p.studentPaysCents,
      teacherCents: p.teacherCents,
      centerCents: p.centerCents,
      teacherSharePercent: p.teacherSharePercent,
      termsVersionId: p.termsVersionId,
      refundPolicy: p.refundPolicy,
      feeRefundableOnStudentCancel: p.feeRefundableOnStudentCancel,
      replayPolicy: p.replayPolicy,
      replayDays: p.replayDays,
      payment: p.payment,
      // Only a payment Darsly verified (or a wallet debit) is money received.
      // A held seat, a declared or claimed transfer, is an amount DUE.
      amountReceived: p.payment?.status === 'PAID' || p.payment?.status === 'REFUNDED',
      refunds: p.refunds,
      createdAt: p.createdAt,
      confirmedAt: p.confirmedAt,
      releasedAt: p.releasedAt,
      cancelledAt: p.cancelledAt,
    }));
  }

  @Get('summary')
  @ApiOperation({ summary: '[admin] What needs a person: pending Live payments, reviews, refund requests' })
  async summary() {
    const [pendingPayments, review, refundRequests] = await Promise.all([
      this.prisma.payment.count({ where: { status: 'PENDING', livePurchaseId: { not: null }, claimedAt: { not: null } } }),
      this.prisma.livePurchase.count({ where: { status: 'NEEDS_REVIEW' } }),
      this.prisma.refund.count({ where: { status: { in: ['REQUESTED', 'APPROVED'] } } }),
    ]);
    return { pendingPayments, review, refundRequests };
  }

  @Post('purchases/:id/release')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Release a reviewed purchase’s earnings (once)' })
  release(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.commerce.adminRelease(id, u.sub);
  }

  @Get('refunds')
  @ApiOperation({ summary: '[admin] Refunds (manual ones carry the destination the buyer gave)' })
  async refunds(@Query('status') status?: string) {
    const rows = await this.prisma.refund.findMany({
      where: status && ['REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED'].includes(status) ? { status: status as never } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        livePurchase: {
          select: {
            id: true,
            status: true,
            sessionId: true,
            session: { select: { title: true, startsAt: true } },
            student: { select: { user: { select: { fullName: true, phone: true } } } },
            guestBuyer: { select: { displayName: true } },
          },
        },
      },
    });
    return rows.map((r) => ({
      ...r,
      buyerName: r.livePurchase.student?.user.fullName ?? r.livePurchase.guestBuyer?.displayName ?? null,
      guest: !!r.livePurchase.guestBuyer,
    }));
  }

  @Post('refunds/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Approve a manual refund (it must have a destination)' })
  approve(@CurrentUser() u: JwtPayload, @Param('id') id: string) {
    return this.commerce.approveRefund(id, u.sub);
  }

  @Post('refunds/:id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Mark an approved manual refund as transferred (books the ledger, once)' })
  complete(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: CompleteRefundDto) {
    return this.commerce.completeRefund(id, u.sub, dto.transferReference);
  }

  @Post('refunds/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Refuse a manual refund, with the reason' })
  reject(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: RejectRefundDto) {
    return this.commerce.rejectRefund(id, u.sub, dto.reason);
  }

  @Post('purchases/:id/refund')
  @HttpCode(200)
  @ApiOperation({ summary: '[admin] Refund a purchase in full (seat and access removed; once)' })
  refund(@CurrentUser() u: JwtPayload, @Param('id') id: string, @Body() dto: AdminRefundDto) {
    return this.commerce.adminRefund(id, u.sub, dto?.reason ?? 'ADMIN');
  }
}
