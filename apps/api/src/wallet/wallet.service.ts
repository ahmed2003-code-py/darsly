import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { validateImageDataUrl } from '../common/image.util';
import { LedgerService } from '../payments/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const PROOF_MAX_BYTES = 1_200 * 1024; // ~1.2 MB screenshot
const MIN_TOPUP_CENTS = 1_000; // 10 EGP
const MAX_TOPUP_CENTS = 5_000_000; // 50,000 EGP — a sanity ceiling, not a policy

export interface SubmitTopupDto {
  amountCents: number;
  method: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  proofImageUrl: string;
  reference?: string;
}

/**
 * The student prepaid wallet. Balance is derived from the double-entry ledger
 * (account `student:<id>:wallet`) — this service never writes a balance number.
 * Money in for now is a proof-based top-up an admin confirms (mirrors manual
 * course payments); spending the balance and listener auto-credit land next.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Student ─────────────────────────────────────────────────────────────────

  async myWallet(userId: string) {
    const student = await this.studentOf(userId);
    const [balanceCents, txns, pending] = await Promise.all([
      this.ledger.walletBalance(student.id),
      this.prisma.walletTransaction.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.walletTopup.findMany({
        where: { studentId: student.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      balanceCents,
      currency: 'EGP',
      transactions: txns.map((t) => ({
        id: t.id,
        kind: t.kind,
        amountCents: t.amountCents,
        description: t.description,
        createdAt: t.createdAt,
      })),
      pendingTopups: pending.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        method: p.method,
        createdAt: p.createdAt,
      })),
    };
  }

  async submitTopup(userId: string, dto: SubmitTopupDto) {
    validateImageDataUrl(dto.proofImageUrl, PROOF_MAX_BYTES);
    const student = await this.studentOf(userId);
    const amount = Math.round(dto.amountCents);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_CENTS || amount > MAX_TOPUP_CENTS) {
      throw new BadRequestException({ message: 'Invalid top-up amount', code: 'INVALID_AMOUNT' });
    }
    const existing = await this.prisma.walletTopup.findFirst({
      where: { studentId: student.id, status: 'PENDING' },
    });
    if (existing) {
      throw new BadRequestException({ message: 'A top-up is already under review', code: 'TOPUP_PENDING' });
    }

    const topup = await this.prisma.walletTopup.create({
      data: {
        studentId: student.id,
        amountCents: amount,
        method: dto.method as any,
        proofImageUrl: dto.proofImageUrl,
        reference: dto.reference?.trim() || null,
        status: 'PENDING',
      },
      select: { id: true, amountCents: true, status: true, createdAt: true },
    });

    await this.notifyAdmins(
      'شحن محفظة بانتظار المراجعة 💳',
      `${student.user.fullName} طلب شحن محفظته بمبلغ ${(amount / 100).toFixed(2)} ج.م.`,
      { topupId: topup.id },
    );
    return topup;
  }

  myTopups(userId: string) {
    return this.studentOf(userId).then((s) =>
      this.prisma.walletTopup.findMany({
        where: { studentId: s.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          amountCents: true,
          method: true,
          status: true,
          rejectedReason: true,
          createdAt: true,
        },
      }),
    );
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  async adminTopups(status = 'PENDING') {
    // Straight from a query string — anything Prisma doesn't recognise as the
    // enum throws, so an unknown value falls back to the default tab rather
    // than 500ing the admin's page.
    const wanted = (['PENDING', 'APPROVED', 'REJECTED'] as const).find((s) => s === status) ?? 'PENDING';
    const rows = await this.prisma.walletTopup.findMany({
      where: { status: wanted },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { student: { select: { user: { select: { fullName: true, phone: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      method: r.method,
      reference: r.reference,
      proofImageUrl: r.proofImageUrl,
      status: r.status,
      rejectedReason: r.rejectedReason,
      createdAt: r.createdAt,
      studentName: r.student.user.fullName,
      studentPhone: r.student.user.phone,
    }));
  }

  /**
   * Confirm a transfer → credit the wallet. Atomic: the status flip guards
   * against a double-approve race (conditional updateMany), and the ledger credit
   * + the WalletTransaction mirror commit with it. Idempotent by construction —
   * a second caller matches zero rows and no funds are added twice.
   *
   * `adminId` is null when the listener matched the transfer itself, which is
   * the path a student's top-up normally takes: `reviewedById` then records
   * that nobody reviewed it, rather than crediting a person who never looked.
   */
  async approveTopup(adminId: string | null, id: string) {
    const topup = await this.prisma.walletTopup.findUnique({ where: { id } });
    if (!topup) throw new NotFoundException('Top-up not found');
    if (topup.status !== 'PENDING') {
      throw new BadRequestException({ message: 'Top-up is not pending', code: 'NOT_PENDING' });
    }

    await this.prisma.$transaction(async (tx) => {
      const flip = await tx.walletTopup.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedById: adminId, reviewedAt: new Date() },
      });
      if (flip.count === 0) return; // another caller already handled it
      const ledgerTxnId = await this.ledger.creditWallet(
        topup.studentId,
        topup.amountCents,
        `wallet top-up ${topup.id}`,
        tx,
      );
      await tx.walletTransaction.create({
        data: {
          studentId: topup.studentId,
          kind: 'TOPUP',
          amountCents: topup.amountCents,
          description: 'شحن المحفظة',
          ledgerTxnId,
        },
      });
    });

    await this.notifyStudent(
      topup.studentId,
      'تم شحن محفظتك ✅',
      `تمت إضافة ${(topup.amountCents / 100).toFixed(2)} ج.م إلى رصيدك.`,
    );
    return { ok: true };
  }

  async rejectTopup(adminId: string, id: string, reason?: string) {
    const topup = await this.prisma.walletTopup.findUnique({ where: { id } });
    if (!topup) throw new NotFoundException('Top-up not found');
    const flip = await this.prisma.walletTopup.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectedReason: reason?.trim() || null,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });
    if (flip.count === 0) {
      throw new BadRequestException({ message: 'Top-up is not pending', code: 'NOT_PENDING' });
    }
    await this.notifyStudent(
      topup.studentId,
      'لم يتم تأكيد شحن المحفظة ❌',
      reason?.trim() ? `السبب: ${reason.trim()}.` : 'يرجى إعادة رفع إثبات تحويل صحيح.',
    );
    return { ok: true };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s) throw new ForbiddenException('No student profile for this account');
    return s;
  }

  private async notifyStudent(studentId: string, title: string, body: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (s) await this.notifications.create({ userId: s.userId, type: 'ANNOUNCEMENT', title, body });
  }

  private async notifyAdmins(title: string, body: string, meta?: Record<string, unknown>) {
    const admins = await this.prisma.user.findMany({
      where: { role: 'SUPER_ADMIN', isActive: true },
      select: { id: true },
    });
    await Promise.all(
      admins.map((a) => this.notifications.create({ userId: a.id, type: 'ANNOUNCEMENT', title, body, meta })),
    );
  }
}
