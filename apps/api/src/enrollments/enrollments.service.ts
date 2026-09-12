import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Coupon, Course, Enrollment } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { reserveCouponUse } from '../payments/coupon-use';
import { computeServiceFee } from '../payments/fee.util';
import { LedgerService } from '../payments/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { activateBundleChildren } from './bundle';

/**
 * What a student is quoted. Deliberately only two numbers.
 *
 * The platform fee is additive — the academy names a price, the student pays that
 * plus the fee, and the academy is credited its price in full. Publishing the
 * split let a student see they were paying the platform, and made the course card
 * (academy price) and the checkout (price + fee) show two different figures for
 * one course. The academy's price and the fee are still computed and stored on
 * the Payment row; they simply are not part of a student-facing response.
 */
export interface Quote {
  /** The course's list price to a student, fee included, before any coupon. */
  basePriceCents: number;
  /** The coupon discount the student actually earned. */
  discountCents: number;
  /** What the student pays. */
  totalCents: number;
  currency: string;
  coupon: { id: string; code: string; maxUses: number | null } | null;
}

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly ledger: LedgerService,
  ) {}

  private async studentProfileOf(userId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!student) throw new BadRequestException('No student profile for this account');
    return student;
  }

  /**
   * Tell the course's teacher something happened on it. Best-effort: a
   * notification that fails must never take the enrolment down with it — the
   * student's place in the course is the part that matters.
   */
  private async notifyTeacher(
    course: { id: string; teacher?: { user?: { id: string } | null } | null },
    title: string,
    body: string,
  ) {
    const teacherUserId = course.teacher?.user?.id;
    if (!teacherUserId) return;
    await this.notifications
      .create({ userId: teacherUserId, type: 'ANNOUNCEMENT', title, body, meta: { courseId: course.id, audience: 'teacher' } })
      .catch(() => undefined);
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
    const basePlusFee = course.priceCents + (await this.serviceFee(course.tenantId, course.priceCents));

    // What the student is shown: one price, and the discount they actually
    // earned. basePriceCents/netCents/feeCents stay out of the response — the
    // split between the academy's price and the platform's fee is not something
    // either side of the transaction needs to see, and publishing it made the
    // course card and the checkout show two different numbers for one course.
    return {
      basePriceCents: basePlusFee,
      discountCents: discount,
      totalCents: net + fee,
      currency: course.currency,
      coupon: coupon ? { id: coupon.id, code: coupon.code, maxUses: coupon.maxUses } : null,
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
   * Enrol in a course. A free course activates immediately unless its teacher
   * asked for approval, in which case it waits. Paid courses go through the
   * manual proof-of-payment flow (POST /payments): this endpoint returns
   * PAYMENT_REQUIRED with the quote so the client opens the pay screen.
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

    // Free course, so the student is in. There is no longer a queue in front of
    // this: a teacher who wants to sell access prices the course, and one who
    // wants it open leaves it free. Making them tick an extra box afterwards
    // only produced a waiting room nobody was watching.
    const data = {
      status: 'ACTIVE' as const,
      approvedAt: new Date(),
      expiresAt: this.expiryFor(course),
      revokedReason: null,
    };
    // A coupon that made the course free is still a use of that coupon — taken
    // in the same transaction as the enrolment, so a one-use code cannot enrol
    // a whole class, and a failed enrolment gives the slot back.
    const enrollment = await this.prisma.$transaction(async (tx) => {
      if (quote.coupon) await reserveCouponUse(tx, quote.coupon.id, quote.coupon.maxUses);
      return existing
        ? tx.enrollment.update({ where: { id: existing.id }, data })
        : tx.enrollment.create({
            data: { studentId: student.id, courseId, tenantId: course.tenantId, ...data },
          });
    });

    await this.notifyTeacher(
      course,
      'طالب جديد انضم 🎉',
      `${student.user.fullName} انضم إلى دورة «${course.title}».`,
    );

    await activateBundleChildren(this.prisma, course, enrollment.studentId, enrollment.expiresAt);
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

  async myEnrollments(userId: string) {
    const student = await this.studentProfileOf(userId);
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: student.id },
      include: {
        course: {
          include: {
            subject: true,
            grades: { include: { grade: true } },
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
          grades: e.course.grades.map((g) => g.grade),
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
        // `netCents` and never `amountCents`: what the student handed over
        // includes the platform's service fee, which is added on top of the
        // price the teacher set. Showing the gross here labels the fee as the
        // teacher's income in their own students list, so every total they read
        // is larger than the money that will ever reach them.
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, netCents: true, createdAt: true },
        },
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

  async revoke(tenantId: string, id: string, reason?: string) {
    const enrollment = await this.assertTenantEnrollment(tenantId, id);
    if (enrollment.status !== 'ACTIVE') {
      throw new BadRequestException('Only active enrollments can be revoked');
    }
    const flip = await this.prisma.enrollment.updateMany({
      where: { id, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedReason: reason ?? null },
    });
    if (flip.count === 0) throw new BadRequestException('Only active enrollments can be revoked');
    const updated = await this.prisma.enrollment.findUniqueOrThrow({ where: { id } });
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
