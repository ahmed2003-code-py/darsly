import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Coupon, Course, Enrollment } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { computeServiceFee } from '../payments/fee.util';
import { LedgerService } from '../payments/ledger.service';
import { PrismaService } from '../prisma/prisma.service';

export interface Quote {
  basePriceCents: number;
  discountCents: number;
  /** what the academy earns (price − discount) */
  netCents: number;
  /** platform service fee the student pays on top */
  feeCents: number;
  /** what the student pays = netCents + feeCents */
  totalCents: number;
  currency: string;
  coupon: { id: string; code: string } | null;
}

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
  ) {}

  private async studentProfileOf(userId: string) {
    const student = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!student) throw new BadRequestException('No student profile for this account');
    return student;
  }

  private async resolveCoupon(course: Course, code: string): Promise<Coupon> {
    // findFirst (not findUnique) so the soft-delete filter applies.
    const coupon = await this.prisma.coupon.findFirst({
      where: { tenantId: course.tenantId, code: code.trim().toUpperCase(), deletedAt: null },
    });
    if (!coupon || !coupon.isActive) throw new BadRequestException('Invalid coupon');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('Coupon expired');
    }
    if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) {
      throw new BadRequestException('Coupon usage limit reached');
    }
    if (coupon.courseId && coupon.courseId !== course.id) {
      throw new BadRequestException('Coupon is not valid for this course');
    }
    return coupon;
  }

  /** Price breakdown for a course, optionally with a coupon applied. */
  async quote(courseId: string, couponCode?: string): Promise<Quote> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, status: 'PUBLISHED' },
    });
    if (!course) throw new NotFoundException('Course not found');

    let discount = 0;
    let coupon: Coupon | null = null;
    if (couponCode) {
      coupon = await this.resolveCoupon(course, couponCode);
      discount = coupon.percentOff
        ? Math.round((course.priceCents * coupon.percentOff) / 100)
        : Math.min(coupon.amountOffCents ?? 0, course.priceCents);
    }
    const net = Math.max(0, course.priceCents - discount);
    const fee = await this.serviceFee(course.tenantId, net);
    return {
      basePriceCents: course.priceCents,
      discountCents: discount,
      netCents: net,
      feeCents: fee,
      totalCents: net + fee,
      currency: course.currency,
      coupon: coupon ? { id: coupon.id, code: coupon.code } : null,
    };
  }

  /** Platform service fee for an academy on a given net price (additive model). */
  async serviceFee(academyId: string, netCents: number): Promise<number> {
    if (netCents <= 0) return 0;
    const academy = await this.prisma.academy.findUnique({
      where: { id: academyId },
      select: { feeType: true, feeValue: true },
    });
    // Fall back to the legacy 20% platform cut if the academy row is missing.
    if (!academy) return computeServiceFee('PERCENT', 20, netCents);
    return computeServiceFee(academy.feeType, academy.feeValue, netCents);
  }

  /**
   * Enrol in a course. Free courses activate immediately. Paid courses go
   * through the manual proof-of-payment flow (POST /payments): this endpoint
   * returns PAYMENT_REQUIRED with the quote so the client opens the pay screen.
   */
  async enroll(userId: string, courseId: string, couponCode?: string) {
    const student = await this.studentProfileOf(userId);
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, status: 'PUBLISHED' },
      include: { teacher: { include: { user: { select: { id: true, fullName: true } } } } },
    });
    if (!course) throw new NotFoundException('Course not found');

    const existing = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: student.id, courseId } },
    });
    if (existing?.status === 'ACTIVE' && (!existing.expiresAt || existing.expiresAt > new Date())) {
      throw new ConflictException('Already enrolled in this course');
    }

    const quote = await this.quote(courseId, couponCode);

    // Paid → must pay first (manual proof + verification).
    if (quote.totalCents > 0) {
      throw new BadRequestException({ message: 'Payment required', code: 'PAYMENT_REQUIRED', quote });
    }

    // Free course → activate right away.
    const data = {
      status: 'ACTIVE' as const,
      approvedAt: new Date(),
      expiresAt: this.expiryFor(course),
      revokedReason: null,
    };
    const enrollment = existing
      ? await this.prisma.enrollment.update({ where: { id: existing.id }, data })
      : await this.prisma.enrollment.create({
          data: { studentId: student.id, courseId, tenantId: course.tenantId, ...data },
        });

    await this.activateBundleChildren(course, enrollment);
    await this.notifications.create({
      userId,
      type: 'ENROLLMENT_APPROVED',
      title: 'تم تفعيل اشتراكك',
      body: `أصبح بإمكانك الآن الوصول إلى «${course.title}»`,
      meta: { courseId },
    });
    return { ...enrollment, quote };
  }

  /** MONTHLY_SUBSCRIPTION runs 30 days per cycle; everything else is lifetime. */
  private expiryFor(course: Course): Date | null {
    return course.pricingModel === 'MONTHLY_SUBSCRIPTION'
      ? new Date(Date.now() + 30 * 86_400_000)
      : null;
  }

  /** Activating a BUNDLE unlocks each child course as its own enrollment. */
  private async activateBundleChildren(course: Course, parent: Enrollment) {
    if (course.pricingModel !== 'BUNDLE') return;
    const items = await this.prisma.bundleItem.findMany({ where: { bundleId: course.id } });
    for (const item of items) {
      await this.prisma.enrollment.upsert({
        where: {
          studentId_courseId: { studentId: parent.studentId, courseId: item.courseId },
        },
        update: { status: 'ACTIVE', approvedAt: new Date(), expiresAt: parent.expiresAt },
        create: {
          studentId: parent.studentId,
          courseId: item.courseId,
          tenantId: course.tenantId,
          status: 'ACTIVE',
          approvedAt: new Date(),
          expiresAt: parent.expiresAt,
        },
      });
    }
  }

  async myEnrollments(userId: string) {
    const student = await this.studentProfileOf(userId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: student.id },
      include: {
        course: {
          include: {
            subject: true,
            grade: true,
            teacher: { include: { user: { select: { fullName: true, avatarUrl: true } } } },
            units: { where: { deletedAt: null }, select: { _count: { select: { lessons: { where: { deletedAt: null } } } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Progress + earned certificates per course, for the card UI.
    const [completedRows, certs] = await Promise.all([
      this.prisma.lessonProgress.findMany({
        where: { studentId: student.id, completedAt: { not: null } },
        select: { lesson: { select: { unit: { select: { courseId: true } } } } },
      }),
      this.prisma.certificate.findMany({
        where: { studentId: student.id },
        select: { courseId: true, serial: true, verifyToken: true },
      }),
    ]);
    const completedByCourse = new Map<string, number>();
    for (const r of completedRows) {
      const cid = r.lesson.unit.courseId;
      completedByCourse.set(cid, (completedByCourse.get(cid) ?? 0) + 1);
    }
    const certByCourse = new Map(certs.map((c) => [c.courseId, { serial: c.serial, verifyToken: c.verifyToken }]));

    return enrollments.map((e) => {
      const lessonsCount = e.course.units.reduce((s, u) => s + u._count.lessons, 0);
      const completedLessons = Math.min(lessonsCount, completedByCourse.get(e.course.id) ?? 0);
      return {
        id: e.id,
        status: e.status,
        approvedAt: e.approvedAt,
        expiresAt: e.expiresAt,
        createdAt: e.createdAt,
        completedLessons,
        progressPct: lessonsCount ? Math.round((completedLessons / lessonsCount) * 100) : 0,
        certificateSerial: certByCourse.get(e.course.id)?.serial ?? null,
        certificateToken: certByCourse.get(e.course.id)?.verifyToken ?? null,
        course: {
          id: e.course.id,
          title: e.course.title,
          thumbnailUrl: e.course.thumbnailUrl,
          subject: e.course.subject,
          grade: e.course.grade,
          pricingModel: e.course.pricingModel,
          priceCents: e.course.priceCents,
          lessonsCount,
          teacherName: e.course.teacher.user.fullName,
          teacherSlug: e.course.teacher.slug,
          teacherAvatarUrl: e.course.teacher.user.avatarUrl,
        },
      };
    });
  }

  // ── Teacher side ─────────────────────────────────────────────────────────

  teacherList(tenantId: string, status?: string) {
    return this.prisma.enrollment.findMany({
      where: { tenantId, ...(status ? { status: status as Enrollment['status'] } : {}) },
      include: {
        student: {
          include: {
            user: { select: { fullName: true, phone: true, avatarUrl: true } },
            grade: true,
          },
        },
        course: { select: { id: true, title: true, priceCents: true, pricingModel: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertTenantEnrollment(tenantId: string, id: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { id, tenantId },
      include: {
        course: true,
        student: { include: { user: { select: { id: true } } } },
        payments: { where: { status: 'PENDING' } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    return enrollment;
  }

  async approve(tenantId: string, id: string) {
    const enrollment = await this.assertTenantEnrollment(tenantId, id);
    if (enrollment.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Only pending enrollments can be approved');
    }
    // A paid course can only be activated by confirming a real payment — never
    // by a bare "approve" click. Payments are normally verified from the
    // payments queue; this endpoint is a safety-belted equivalent.
    if (enrollment.course.priceCents > 0 && enrollment.payments.length === 0) {
      throw new BadRequestException({
        message: 'No pending payment to confirm — verify the payment from the payments queue',
        code: 'NO_PENDING_PAYMENT',
      });
    }
    const expiresAt = this.expiryFor(enrollment.course);

    // Atomic: activation + payment confirmation. This is a teacher/owner
    // self-action (@AcademyStaff('student.manage')), so — like a manual verify —
    // the payment is marked PAID (student activated) but left pending settlement:
    // the withdrawable ledger credit is deferred to an independent settlement (a
    // trusted payment-event or an admin). The coupon slot was reserved at submit,
    // so it is NOT incremented here.
    const updated = await this.prisma.$transaction(async (tx) => {
      const flip = await tx.enrollment.updateMany({
        where: { id, status: 'PENDING_APPROVAL' },
        data: { status: 'ACTIVE', approvedAt: new Date(), expiresAt },
      });
      if (flip.count === 0) return null; // another caller handled it

      for (const payment of enrollment.payments) {
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'PAID', paidAt: new Date() },
        });
      }
      return tx.enrollment.findUnique({ where: { id } });
    });
    if (!updated) throw new BadRequestException('Only pending enrollments can be approved');

    for (const payment of enrollment.payments) await this.ledger.ensureInvoice(payment.id);
    await this.activateBundleChildren(enrollment.course, updated);
    await this.notifications.create({
      userId: enrollment.student.user.id,
      type: 'ENROLLMENT_APPROVED',
      title: 'تمت الموافقة على التحاقك',
      body: `وافق المعلم على التحاقك بدورة «${enrollment.course.title}»`,
      meta: { courseId: enrollment.courseId },
    });
    return updated;
  }

  async reject(tenantId: string, id: string, reason?: string) {
    const enrollment = await this.assertTenantEnrollment(tenantId, id);
    if (enrollment.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Only pending enrollments can be rejected');
    }
    // Fail the pending payments AND release each coupon slot they reserved at
    // submit time (a rejected enrollment must not permanently consume a use).
    const updated = await this.prisma.$transaction(async (tx) => {
      const enr = await tx.enrollment.update({
        where: { id },
        data: { status: 'REJECTED', revokedReason: reason ?? null },
      });
      await tx.payment.updateMany({
        where: { enrollmentId: id, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
      for (const p of enrollment.payments) {
        if (p.couponId) {
          await tx.coupon.updateMany({
            where: { id: p.couponId, usedCount: { gt: 0 } },
            data: { usedCount: { decrement: 1 } },
          });
        }
      }
      return enr;
    });
    await this.notifications.create({
      userId: enrollment.student.user.id,
      type: 'ANNOUNCEMENT',
      title: 'تم رفض طلب الالتحاق',
      body: `عذراً، رُفض طلب التحاقك بدورة «${enrollment.course.title}»${reason ? ` — ${reason}` : ''}`,
      meta: { courseId: enrollment.courseId },
    });
    return updated;
  }

  async revoke(tenantId: string, id: string, reason?: string) {
    const enrollment = await this.assertTenantEnrollment(tenantId, id);
    if (enrollment.status !== 'ACTIVE') {
      throw new BadRequestException('Only active enrollments can be revoked');
    }
    const updated = await this.prisma.enrollment.update({
      where: { id },
      data: { status: 'REVOKED', revokedReason: reason ?? null },
    });
    await this.notifications.create({
      userId: enrollment.student.user.id,
      type: 'SECURITY_ALERT',
      title: 'تم إيقاف وصولك للدورة',
      body: `أوقف المعلم وصولك لدورة «${enrollment.course.title}»${reason ? ` — ${reason}` : ''}`,
      meta: { courseId: enrollment.courseId },
    });
    return updated;
  }
}
