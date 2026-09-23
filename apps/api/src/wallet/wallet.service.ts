import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProofStorageService } from '../storage/proof-storage.service';
import { LedgerService } from '../payments/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePayerReference } from '../payments/payer-reference';
import { checkProofAgainstClaim } from '../payments/proof-check';
import { ProofReaderService } from '../payments/proof-reader.service';

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
    private readonly proofs: ProofStorageService,
    private readonly proofReader: ProofReaderService,
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

  /**
   * The handles we ask people to transfer TO — never a valid answer to "which
   * number did you transfer FROM". An enrichment, not a precondition: if the
   * lookup fails the reference is simply checked without it.
   */
  private async receivingHandles(): Promise<string[]> {
    try {
      const accounts = await this.prisma.platformPaymentAccount.findMany({
        select: { handle: true },
      });
      return accounts.map((a) => a.handle);
    } catch {
      return [];
    }
  }

  async submitTopup(userId: string, dto: SubmitTopupDto) {
    const student = await this.studentOf(userId);
    const amount = Math.round(dto.amountCents);
    if (!Number.isFinite(amount) || amount < MIN_TOPUP_CENTS || amount > MAX_TOPUP_CENTS) {
      throw new BadRequestException({ message: 'Invalid top-up amount', code: 'INVALID_AMOUNT' });
    }

    /**
     * What the receipt says, before anything is stored.
     *
     * Read from the image the student is holding: the amount on it, the minute
     * it was sent, and which account it went to. A receipt that contradicts the
     * form — 2,000 on the picture against 500 typed, or a transfer made out to
     * somebody else's InstaPay address — is refused here, in front of them,
     * while they can still fix it. It is also what identifies the transfer
     * later, since InstaPay gives the two sides different references.
     *
     * A receipt we could not read is not an obstacle: it lands as PENDING with
     * no reading, exactly as every top-up did before.
     */
    const reading = await this.proofReader.read(dto.proofImageUrl);
    const check = checkProofAgainstClaim(
      reading,
      { amountCents: amount },
      await this.receivingHandles(),
    );
    if (check.verdict === 'DISAGREES') {
      throw new BadRequestException({
        message: check.problems.join(' '),
        code: 'PROOF_DISAGREES',
        problems: check.problems,
      });
    }

    // An object, not a row: see ProofStorageService. Dropped if the row fails.
    const proofKey = await this.proofs.store('topups', dto.proofImageUrl, PROOF_MAX_BYTES);
    /**
     * "Already under review" is checked twice, on purpose.
     *
     * This read is the friendly answer — it is what lets the student be told
     * why, in a sentence, before anything is written. What it is not is a
     * guarantee: two submits a few milliseconds apart both run it, both find
     * nothing, and both proceed. The partial unique index added alongside this
     * is the actual rule, and the P2002 below is that rule speaking.
     *
     * A duplicate pending top-up is not a cosmetic problem. Each one carries a
     * transfer receipt an admin will approve, and approving two receipts for
     * one transfer credits the wallet twice.
     */
    const existing = await this.prisma.walletTopup.findFirst({
      where: { studentId: student.id, status: 'PENDING' },
    });
    if (existing) {
      await this.proofs.discard(proofKey);
      throw new BadRequestException({
        message: 'A top-up is already under review',
        code: 'TOPUP_PENDING',
      });
    }

    const topup = await this.prisma.walletTopup
      .create({
        data: {
          studentId: student.id,
          amountCents: amount,
          method: dto.method as any,
          proofImageUrl: proofKey,
          // Same rule as a course payment: a top-up is the same transfer with no
          // course attached, matched on the same single identifier.
          reference: normalizePayerReference(
            dto.method,
            dto.reference,
            await this.receivingHandles(),
          ),
          proofReading: (reading ?? undefined) as never,
          status: 'PENDING',
        },
        select: { id: true, amountCents: true, status: true, createdAt: true },
      })
      .catch(async (e) => {
        await this.proofs.discard(proofKey);
        // The race the read above cannot close: the other submit committed
        // first. Answered with the same refusal it would have received a
        // millisecond earlier, so the student sees one answer however the race
        // resolves rather than a 500 for a double tap.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new BadRequestException({
            message: 'A top-up is already under review',
            code: 'TOPUP_PENDING',
          });
        }
        throw e;
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
    const wanted =
      (['PENDING', 'APPROVED', 'REJECTED'] as const).find((s) => s === status) ?? 'PENDING';
    const rows = await this.prisma.walletTopup.findMany({
      where: { status: wanted },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { student: { select: { user: { select: { fullName: true, phone: true } } } } },
    });

    // Who signed off, so the owner can see it was a person and which one — or
    // that nobody did and the bank's own SMS matched it. `reviewedById` carries
    // no relation, so the names are resolved in one extra query rather than by
    // reshaping the schema for a label.
    const reviewerIds = [
      ...new Set(rows.map((r) => r.reviewedById).filter((v): v is string => !!v)),
    ];
    const reviewers = new Map(
      reviewerIds.length
        ? (
            await this.prisma.user.findMany({
              where: { id: { in: reviewerIds } },
              select: { id: true, fullName: true },
            })
          ).map((u) => [u.id, u.fullName])
        : [],
    );
    return rows.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      method: r.method,
      reference: r.reference,
      proofImageUrl: this.proofs.urlFor(r.proofImageUrl),
      status: r.status,
      rejectedReason: r.rejectedReason,
      createdAt: r.createdAt,
      studentName: r.student.user.fullName,
      studentPhone: r.student.user.phone,
      proofReading: r.proofReading,
      reviewedAt: r.reviewedAt,
      /** Null on an APPROVED row means the transfer matched itself. */
      reviewedByName: r.reviewedById ? (reviewers.get(r.reviewedById) ?? null) : null,
      reviewedAutomatically: r.status !== 'PENDING' && !r.reviewedById,
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

    // Crediting somebody's money is an act, and an act needs a record: which
    // top-up, how much, and who decided — or that nobody did and the bank's own
    // SMS matched it. Outside the transaction on purpose: a failure to write
    // the log must not roll back a credit that already reached the student.
    await this.audit(adminId, 'wallet.topup.approve', topup.id, {
      amountCents: topup.amountCents,
      method: topup.method,
      studentId: topup.studentId,
      by: adminId ? 'admin' : 'auto-match',
    });

    await this.notifyStudent(
      topup.studentId,
      'تم شحن محفظتك ✅',
      `تمت إضافة ${(topup.amountCents / 100).toFixed(2)} ج.م إلى رصيدك.`,
    );
    return { ok: true };
  }

  /**
   * One line in the ledger of who did what. Never throws into the caller: the
   * money has already moved by the time this runs, and losing the log is bad
   * where losing the credit would be worse.
   */
  private async audit(
    actorUserId: string | null,
    action: string,
    entityId: string,
    meta: Record<string, unknown>,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: { actorUserId, action, entity: 'WalletTopup', entityId, meta: meta as never },
      });
    } catch {
      // Logged by Prisma; not worth failing a completed credit over.
    }
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
    await this.audit(adminId, 'wallet.topup.reject', topup.id, {
      amountCents: topup.amountCents,
      method: topup.method,
      studentId: topup.studentId,
      reason: reason?.trim() || null,
    });

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
      admins.map((a) =>
        this.notifications.create({ userId: a.id, type: 'ANNOUNCEMENT', title, body, meta }),
      ),
    );
  }
}
