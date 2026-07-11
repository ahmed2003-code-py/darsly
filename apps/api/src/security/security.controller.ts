import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload, Role } from '@darsly/shared-types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Teacher security tab (security_anti_leak design): live suspicious-session
 * alerts, playback sessions, and the Leak-Trace tool that resolves a leaked
 * clip's watermark ID back to the exact student + session.
 */
@ApiTags('security')
@ApiBearerAuth()
@Roles(Role.TEACHER)
@Controller('teacher/security')
export class SecurityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('events')
  @ApiOperation({ summary: '[teacher] Security events in my tenant' })
  events(@CurrentUser() user: JwtPayload, @Query('resolved') resolved?: string) {
    return this.prisma.securityEvent.findMany({
      where: {
        tenantId: user.tenantId,
        ...(resolved === undefined ? {} : { resolvedAt: resolved === 'true' ? { not: null } : null }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { student: { include: { user: { select: { fullName: true, phone: true } } } } },
    });
  }

  @Get('sessions')
  @ApiOperation({ summary: '[teacher] Recent playback sessions in my tenant' })
  sessions(@CurrentUser() user: JwtPayload) {
    return this.prisma.playbackSession.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: {
        student: { include: { user: { select: { fullName: true, phone: true } } } },
        lesson: { select: { title: true } },
      },
    });
  }

  /**
   * Leak-Trace: given the watermark ID burned into a leaked clip, resolve the
   * exact student, session, device, IP and time. Logs a LEAK_TRACED event so
   * the trace itself is auditable.
   */
  @Get('trace/:watermarkId')
  @ApiOperation({ summary: '[teacher] Resolve a watermark ID to its student + session' })
  async trace(@CurrentUser() user: JwtPayload, @Param('watermarkId') watermarkId: string) {
    const session = await this.prisma.playbackSession.findFirst({
      where: { watermarkId: watermarkId.trim().toUpperCase(), tenantId: user.tenantId },
      include: {
        student: { include: { user: { select: { fullName: true, phone: true, email: true } } } },
        lesson: { select: { title: true, unit: { select: { course: { select: { title: true } } } } } },
        deviceSession: { select: { deviceName: true, userAgent: true, ip: true } },
      },
    });
    if (!session) throw new NotFoundException('No session matches this watermark ID');

    await this.prisma.securityEvent.create({
      data: {
        type: 'LEAK_TRACED',
        severity: 'CRITICAL',
        tenantId: user.tenantId,
        studentId: session.studentId,
        meta: { watermarkId, tracedBy: user.sub, playbackSessionId: session.id },
      },
    });

    return {
      watermarkId: session.watermarkId,
      student: {
        name: session.student.user.fullName,
        phone: session.student.user.phone,
        email: session.student.user.email,
      },
      lesson: session.lesson.title,
      course: session.lesson.unit.course.title,
      ip: session.ip,
      country: session.country,
      device: session.deviceSession?.deviceName ?? session.userAgent,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    };
  }
}
