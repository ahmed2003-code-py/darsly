import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TeacherStatus } from '@darsly/shared-types';
import { ACADEMY_STATUS_FOR, provisionTeacherAcademy } from '../academy/provision';
import { LedgerService } from '../payments/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  async overview() {
    const [
      students, teachersApproved, teachersPending, coursesPublished,
      activeEnrollments, pendingPayouts, totals,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: 'STUDENT' } }),
      this.prisma.teacherProfile.count({ where: { status: 'APPROVED' } }),
      this.prisma.teacherProfile.count({ where: { status: 'PENDING' } }),
      this.prisma.course.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.enrollment.count({ where: { status: 'ACTIVE' } }),
      this.prisma.payoutRequest.count({ where: { status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } } }),
      this.ledger.platformTotals(),
    ]);
    return {
      students,
      teachersApproved,
      teachersPending,
      coursesPublished,
      activeEnrollments,
      pendingPayouts,
      grossCents: totals.grossCents,
      commissionCents: totals.commissionCents,
    };
  }

  listTeachers(status?: TeacherStatus) {
    return this.prisma.teacherProfile.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, email: true, phone: true, avatarUrl: true } },
        subject: true,
        _count: { select: { courses: true } },
      },
    });
  }

  async setTeacherStatus(id: string, status: TeacherStatus, adminUserId: string) {
    const teacher = await this.prisma.teacherProfile.findUnique({
      where: { id },
      include: { user: { select: { id: true, fullName: true } } },
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
        autoApproveEnrollments: updated.autoApproveEnrollments,
        commissionPercent: updated.commissionPercent,
      },
      teacher.user.fullName,
    );
    await this.prisma.academy.update({
      where: { id: updated.id },
      data: { status: ACADEMY_STATUS_FOR[status] ?? 'PENDING' },
    });
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

  auditLogs() {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: { actor: { select: { fullName: true, role: true } } },
    });
  }
}
