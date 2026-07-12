import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@darsly/shared-types';
import { validateImageDataUrl } from '../common/image.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeServiceFee } from './fee.util';
import { LedgerService } from './ledger.service';

const PROOF_MAX_BYTES = 1_200 * 1024; // ~1.2 MB screenshot

export interface SubmitPaymentDto {
  courseId: string;
  method: 'INSTAPAY' | 'VODAFONE_CASH' | 'BANK_TRANSFER' | 'OTHER';
  proofImageUrl: string;
  reference?: string;
  couponCode?: string;
}

@Injectable()
export class ManualPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Student: submit a proof of payment ──────────────────────────────────────

  async submit(userId: string, dto: SubmitPaymentDto) {
    validateImageDataUrl(dto.proofImageUrl, PROOF_MAX_BYTES);
    const student = await this.studentOf(userId);
    const course = await this.prisma.course.findFirst({
      where: { id: dto.courseId, status: 'PUBLISHED' },
      include: { teacher: { include: { user: { select: { id: true } } } } },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.priceCents <= 0) {
      throw new BadRequestException({ message: 'This course is free — just enrol', code: 'COURSE_FREE' });
    }

    // Block a second pending submission / an already-active enrolment.
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
    });
    if (enrollment?.status === 'ACTIVE' && (!enrollment.expiresAt || enrollment.expiresAt > new Date())) {
      throw new ConflictException({ message: 'Already enrolled', code: 'ALREADY_ENROLLED' });
    }
    const pending = await this.prisma.payment.findFirst({
      where: { studentId: student.id, courseId: course.id, status: 'PENDING' },
    });
    if (pending) throw new ConflictException({ message: 'A payment is already under review', code: 'PAYMENT_PENDING' });

    const { netCents, feeCents, totalCents, couponId } = await this.quote(course, dto.couponCode);

    // Enrolment sits PENDING_APPROVAL (= awaiting payment verification).
    const enr = enrollment
      ? await this.prisma.enrollment.update({
          where: { id: enrollment.id },
          data: { status: 'PENDING_APPROVAL', approvedAt: null, revokedReason: null },
        })
      : await this.prisma.enrollment.create({
          data: { studentId: student.id, courseId: course.id, tenantId: course.tenantId, status: 'PENDING_APPROVAL' },
        });

    const payment = await this.prisma.payment.create({
      data: {
        studentId: student.id,
        courseId: course.id,
        enrollmentId: enr.id,
        tenantId: course.tenantId,
        amountCents: totalCents,
        feeCents,
        netCents,
        currency: course.currency,
        gateway: 'manual',
        method: dto.method as any,
        proofImageUrl: dto.proofImageUrl,
        reference: dto.reference?.trim() || null,
        couponId,
        status: 'PENDING',
      },
      select: { id: true, status: true, amountCents: true, createdAt: true },
    });

    await this.notifications.create({
      userId: course.teacher.user.id,
      type: 'ANNOUNCEMENT',
      title: 'دفعة جديدة بانتظار المراجعة 💳',
      body: `${student.user.fullName} رفع إثبات دفع لدورة «${course.title}».`,
      meta: { paymentId: payment.id, courseId: course.id },
    });
    return payment;
  }

  // ── Verify / reject (teacher for own courses, admin for any) ────────────────

  async verify(user: { sub: string; role: string; tenantId?: string }, paymentId: string) {
    const payment = await this.authorizePayment(user, paymentId);
    return this.applyVerification(payment, user.sub, false);
  }

  /** Auto-verification by the notification-listener matching engine. */
  async systemVerify(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return this.applyVerification(payment, 'system', true);
  }

  private async applyVerification(
    payment: { id: string; status: string; courseId: string; enrollmentId: string | null; studentId: string; couponId: string | null },
    verifierId: string,
    auto: boolean,
  ) {
    if (payment.status !== 'PENDING') {
      // Fast path; the authoritative guard is the conditional update below.
      if (auto) return { ok: true, alreadyHandled: true };
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }
    const course = await this.prisma.course.findUnique({
      where: { id: payment.courseId },
      select: { pricingModel: true, title: true },
    });
    const expiresAt = course?.pricingModel === 'MONTHLY_SUBSCRIPTION'
      ? new Date(Date.now() + 30 * 86_400_000)
      : null;

    // Atomic: the status flip, the enrollment activation, the ledger credit, and
    // the coupon increment all commit together (no "PAID but never credited"
    // window). The conditional updateMany guards against a double-verify race
    // (teacher + auto-matcher, or two verifiers) — exactly one caller proceeds.
    const handled = await this.prisma.$transaction(async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date(), verifiedById: verifierId },
      });
      if (flip.count === 0) return false; // another caller already handled it

      if (payment.enrollmentId) {
        await tx.enrollment.update({
          where: { id: payment.enrollmentId },
          data: { status: 'ACTIVE', approvedAt: new Date(), expiresAt },
        });
      }
      await this.ledger.recordPayment(payment.id, tx);
      if (payment.couponId) {
        await tx.coupon.update({ where: { id: payment.couponId }, data: { usedCount: { increment: 1 } } });
      }
      return true;
    });

    if (!handled) {
      if (auto) return { ok: true, alreadyHandled: true };
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }

    // Non-critical follow-ups (a failure here never un-credits the teacher).
    await this.ledger.ensureInvoice(payment.id);
    await this.notifyStudent(payment.studentId, 'ENROLLMENT_APPROVED',
      auto ? 'تم تأكيد دفعتك تلقائياً ✅' : 'تم تأكيد دفعتك ✅',
      `تم تفعيل اشتراكك في «${course?.title ?? 'الدورة'}». مذاكرة سعيدة!`);
    return { ok: true };
  }

  async reject(user: { sub: string; role: string; tenantId?: string }, paymentId: string, reason?: string) {
    const payment = await this.authorizePayment(user, paymentId);
    if (payment.status !== 'PENDING') {
      throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
    }
    // Move the payment AND its pending enrollment out of the review state together,
    // so a rejected payment can never leave a PENDING_APPROVAL enrollment that a
    // stray "approve" action could later activate for free.
    await this.prisma.$transaction(async (tx) => {
      const flip = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: { status: 'REJECTED', rejectedReason: reason?.trim() || null, verifiedById: user.sub },
      });
      if (flip.count === 0) {
        throw new BadRequestException({ message: 'Payment is not pending', code: 'NOT_PENDING' });
      }
      if (payment.enrollmentId) {
        await tx.enrollment.updateMany({
          where: { id: payment.enrollmentId, status: 'PENDING_APPROVAL' },
          data: { status: 'REJECTED', revokedReason: reason?.trim() || 'payment rejected' },
        });
      }
    });
    await this.notifyStudent(payment.studentId, 'ANNOUNCEMENT', 'لم يتم تأكيد الدفعة ❌',
      reason?.trim() ? `السبب: ${reason.trim()}. يمكنك إعادة رفع إثبات صحيح.` : 'يرجى إعادة رفع إثبات دفع صحيح.');
    return { ok: true };
  }

  // ── Queues ──────────────────────────────────────────────────────────────────

  teacherQueue(tenantId: string, status = 'PENDING') {
    return this.list({ tenantId, status });
  }
  adminQueue(status = 'PENDING') {
    return this.list({ status });
  }

  private async list(where: { tenantId?: string; status?: string }) {
    const rows = await this.prisma.payment.findMany({
      where: {
        ...(where.tenantId ? { tenantId: where.tenantId } : {}),
        ...(where.status ? { status: where.status as any } : {}),
        gateway: 'manual',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        student: { select: { user: { select: { fullName: true, phone: true } } } },
        course: { select: { title: true } },
      },
    });
    return rows.map((p) => ({
      id: p.id,
      status: p.status,
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      proofImageUrl: p.proofImageUrl,
      rejectedReason: p.rejectedReason,
      createdAt: p.createdAt,
      studentName: p.student.user.fullName,
      studentPhone: p.student.user.phone,
      courseTitle: p.course.title,
    }));
  }

  async myPayments(userId: string) {
    const student = await this.studentOf(userId);
    const rows = await this.prisma.payment.findMany({
      where: { studentId: student.id, gateway: 'manual' },
      orderBy: { createdAt: 'desc' },
      include: { course: { select: { title: true } } },
    });
    return rows.map((p) => ({
      id: p.id,
      status: p.status,
      amountCents: p.amountCents,
      method: p.method,
      rejectedReason: p.rejectedReason,
      createdAt: p.createdAt,
      courseId: p.courseId,
      courseTitle: p.course.title,
    }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async authorizePayment(user: { role: string; tenantId?: string }, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    const isAdmin = user.role === Role.SUPER_ADMIN;
    const isOwnerTeacher = user.role === Role.TEACHER && user.tenantId === payment.tenantId;
    if (!isAdmin && !isOwnerTeacher) throw new ForbiddenException('Not allowed to review this payment');
    return payment;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s;
  }

  private async quote(course: { id: string; priceCents: number; tenantId: string }, couponCode?: string) {
    let discount = 0;
    let couponId: string | null = null;
    if (couponCode) {
      const coupon = await this.prisma.coupon.findFirst({
        where: { tenantId: course.tenantId, code: couponCode.trim().toUpperCase(), isActive: true, deletedAt: null },
      });
      if (coupon && (!coupon.expiresAt || coupon.expiresAt > new Date()) &&
          (coupon.maxUses == null || coupon.usedCount < coupon.maxUses) &&
          (!coupon.courseId || coupon.courseId === course.id)) {
        discount = coupon.percentOff
          ? Math.round((course.priceCents * coupon.percentOff) / 100)
          : Math.min(coupon.amountOffCents ?? 0, course.priceCents);
        couponId = coupon.id;
      }
    }
    // Additive platform service fee: student pays net + fee (never a deduction
    // from the academy). tenantId === academyId (identity-preserving).
    const netCents = Math.max(0, course.priceCents - discount);
    let feeCents = 0;
    if (netCents > 0) {
      const academy = await this.prisma.academy.findUnique({
        where: { id: course.tenantId },
        select: { feeType: true, feeValue: true },
      });
      feeCents = academy
        ? computeServiceFee(academy.feeType, academy.feeValue, netCents)
        : computeServiceFee('PERCENT', 20, netCents);
    }
    return { netCents, feeCents, totalCents: netCents + feeCents, couponId };
  }

  private async notifyStudent(studentId: string, type: string, title: string, body: string) {
    const s = await this.prisma.studentProfile.findUnique({ where: { id: studentId }, select: { userId: true } });
    if (s) await this.notifications.create({ userId: s.userId, type: type as any, title, body });
  }
}
