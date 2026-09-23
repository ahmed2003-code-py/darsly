import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TeacherStatus } from '@darsly/shared-types';
import { ACADEMY_STATUS_FOR, provisionTeacherAcademy } from '../academy/provision';
import { MailService } from '../mail/mail.service';
import { teacherApprovedEmail, teacherStatusChangedEmail } from '../mail/templates';
import { LedgerService } from '../payments/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  async overview() {
    const [
      students,
      teachersApproved,
      teachersPending,
      coursesPublished,
      activeEnrollments,
      totalEnrollments,
      pendingPayouts,
      totals,
      totalAcademies,
      activeAcademies,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'STUDENT' } }),
      this.prisma.teacherProfile.count({ where: { status: 'APPROVED' } }),
      this.prisma.teacherProfile.count({ where: { status: 'PENDING' } }),
      this.prisma.course.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.enrollment.count({ where: { status: 'ACTIVE' } }),
      this.prisma.enrollment.count(),
      this.prisma.payoutRequest.count({
        where: { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } },
      }),
      this.ledger.platformTotals(),
      this.prisma.academy.count(),
      this.prisma.academy.count({ where: { status: 'ACTIVE' } }),
    ]);
    return {
      students,
      teachersApproved,
      teachersPending,
      coursesPublished,
      activeEnrollments,
      totalEnrollments,
      pendingPayouts,
      grossCents: totals.grossCents,
      commissionCents: totals.commissionCents,
      totalAcademies,
      activeAcademies,
    };
  }

  listTeachers(status?: TeacherStatus) {
    return this.prisma.teacherProfile.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, email: true, phone: true, avatarUrl: true } },
        subjects: { include: { subject: true } },
        _count: { select: { courses: true } },
      },
    });
  }

  async setTeacherStatus(id: string, status: TeacherStatus, adminUserId: string) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id },
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
    if (!teacher) throw new NotFoundException('Teacher not found');

    const updated = await this.prisma.teacherProfile.update({
      where: { id },
      data: { status, verifiedAt: status === 'APPROVED' ? new Date() : teacher.verifiedAt },
    });

    // Make sure the teacher's Academy + OWNER membership exist (heals accounts
    // created before academy auto-provisioning), then mirror the new status onto
    // the academy so the storefront reflects approval/suspension.
    await provisionTeacherAcademy(
      this.prisma,
      {
        id: updated.id,
        slug: updated.slug,
        userId: teacher.user.id,
        status,
        language: updated.language,
        maxConcurrentSessions: updated.maxConcurrentSessions,
        commissionPercent: updated.commissionPercent,
      },
      teacher.user.fullName,
    );
    await this.prisma.academy.update({
      where: { id: updated.id },
      data: { status: ACADEMY_STATUS_FOR[status] ?? 'PENDING' },
    });
    // A suspension that only bites at the next login leaves every live token
    // valid for its full TTL. Evict now; the guard's revocation check makes
    // the very next request fail, and buildContext refuses the teacher in
    // every academy they belong to until they are approved again.
    if (status === 'SUSPENDED' || status === 'REJECTED') {
      await this.prisma.deviceSession.updateMany({
        where: { userId: teacher.user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: `TEACHER_${status}` },
      });
    }
    const messages: Record<string, [string, string]> = {
      APPROVED: ['تم اعتماد حسابك', 'تهانينا! تم اعتماد حسابك كمعلم ويمكنك الآن نشر دوراتك.'],
      REJECTED: ['تم رفض طلبك', 'عذراً، لم يتم اعتماد حسابك كمعلم.'],
      SUSPENDED: ['تم إيقاف حسابك', 'تم إيقاف حسابك مؤقتاً. تواصل مع الدعم.'],
    };
    const msg = messages[status];
    if (msg) {
      await this.notifications.create({
        userId: teacher.user.id,
        type: 'ANNOUNCEMENT',
        title: msg[0],
        body: msg[1],
      });
      // The in-app bell only reaches a teacher who is already logged in — and a
      // PENDING teacher cannot log in at all, so approval has to travel by mail.
      if (teacher.user.email) {
        const name = teacher.user.fullName;
        this.mail.sendInBackground({
          to: teacher.user.email,
          ...(status === 'APPROVED'
            ? teacherApprovedEmail({ name, loginUrl: this.mail.webUrl('/login') })
            : teacherStatusChangedEmail({ name, status: status as 'REJECTED' | 'SUSPENDED' })),
        });
      }
    }
    await this.prisma.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: `teacher.status.${status.toLowerCase()}`,
        entity: 'TeacherProfile',
        entityId: id,
      },
    });
    return updated;
  }

  securityEvents(resolved?: boolean) {
    return this.prisma.securityEvent.findMany({
      where: resolved === undefined ? {} : { resolvedAt: resolved ? { not: null } : null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        tenant: { include: { user: { select: { fullName: true } } } },
        student: { include: { user: { select: { fullName: true } } } },
      },
    });
  }

  /** Platform-wide by default; an academyId narrows it to that academy's own
   *  activity — the per-academy "Activity" tab reuses this, not a second
   *  audit read path. */
  auditLogs(academyId?: string) {
    return this.prisma.auditLog.findMany({
      where: academyId ? { academyId } : {},
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: { actor: { select: { fullName: true, role: true } } },
    });
  }
}
