import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtPayload, Role, WatermarkPayload } from '@darsly/shared-types';
import { randomBytes, randomUUID } from 'crypto';
import { DRM_PROVIDER, IDrmProvider } from '../video/drm/drm.provider';
import { CertificatesService } from '../assessments/certificates.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProgressService } from '../progress/progress.service';

export interface DeviceCtx {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class PlaybackService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DRM_PROVIDER) private readonly drm: IDrmProvider,
    private readonly progress: ProgressService,
    private readonly notifications: NotificationsService,
    private readonly certificates: CertificatesService,
  ) {}

  /** DRS-89421-A8X9 — human-readable, shown in the overlay & used by leak-trace. */
  private newWatermarkId(): string {
    const digits = String(10000 + Math.floor(Math.random() * 89999));
    const suffix = randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    return `DRS-${digits}-${suffix}`;
  }

  private async studentOf(userId: string) {
    const s = await this.prisma.studentProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true, phone: true } } },
    });
    if (!s) throw new BadRequestException('No student profile for this account');
    return s;
  }

  /**
   * Full access decision for a lesson's video. Returns the loaded lesson +
   * effective caps. Throws 403/404 with a reason otherwise. Applies:
   * ownership/admin bypass, free preview, active enrollment, drip unlock,
   * time-window (accessWindowDays), and views cap.
   */
  private async resolveAccess(userId: string, role: Role, lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        videoAsset: true,
        unit: { include: { course: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    const course = lesson.unit.course;

    // Decide ACCESS first — never leak video state to an unauthorized viewer.
    // Owner teacher / super admin can always preview.
    if (role === Role.SUPER_ADMIN) {
      this.assertVideoReady(lesson);
      return { lesson, course, student: null, progress: null, viewsCap: null };
    }
    if (role === Role.TEACHER) {
      const teacher = await this.prisma.teacherProfile.findUnique({ where: { userId } });
      if (teacher && teacher.id === course.tenantId) {
        this.assertVideoReady(lesson);
        return { lesson, course, student: null, progress: null, viewsCap: null };
      }
      throw new ForbiddenException('Not your course');
    }

    // Students: free preview is open; otherwise require an active enrollment.
    const student = await this.studentOf(userId);
    if (!lesson.isFreePreview) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { studentId_courseId: { studentId: student.id, courseId: course.id } },
      });
      const active =
        enrollment?.status === 'ACTIVE' &&
        (!enrollment.expiresAt || enrollment.expiresAt > new Date());
      if (!active) throw new ForbiddenException('Not enrolled in this course');

      // Drip: fixed date, or N days after enrollment approval.
      const now = Date.now();
      if (lesson.dripUnlockAt && lesson.dripUnlockAt.getTime() > now) {
        throw new ForbiddenException('Lesson is not unlocked yet');
      }
      if (
        lesson.dripAfterEnrollDays != null &&
        enrollment!.approvedAt &&
        enrollment!.approvedAt.getTime() + lesson.dripAfterEnrollDays * 86_400_000 > now
      ) {
        throw new ForbiddenException('Lesson is not unlocked yet');
      }
    }

    const progress = await this.prisma.lessonProgress.findUnique({
      where: { studentId_lessonId: { studentId: student.id, lessonId } },
    });

    // Time-window: access expires N days after the lesson was first unlocked.
    const windowDays = lesson.accessWindowDays ?? course.accessWindowDays ?? null;
    if (windowDays != null && progress?.firstUnlockedAt) {
      const expires = progress.firstUnlockedAt.getTime() + windowDays * 86_400_000;
      if (Date.now() > expires) {
        throw new ForbiddenException('Lesson access window has expired');
      }
    }

    // Views cap: max distinct plays per student.
    const viewsCap = lesson.viewsCap ?? course.defaultViewsCap ?? null;
    if (viewsCap != null && (progress?.viewCount ?? 0) >= viewsCap) {
      await this.flag('VIEW_CAP_EXCEEDED', 'WARNING', {
        tenantId: course.tenantId,
        studentId: student.id,
        meta: { lessonId, viewsCap },
      });
      throw new ForbiddenException('You have reached the maximum number of views for this lesson');
    }

    // Only now — the viewer is authorized — do we surface video readiness.
    this.assertVideoReady(lesson);
    return { lesson, course, student, progress, viewsCap };
  }

  private assertVideoReady(lesson: { videoAsset: { status: string } | null }): void {
    if (!lesson.videoAsset || lesson.videoAsset.status !== 'READY') {
      throw new BadRequestException('Lesson video is not ready');
    }
  }

  /**
   * Begin a protected playback session: enforce access, open the access window
   * + count the view, mint a forensic watermark, create the PlaybackSession,
   * and return signed credentials + the watermark payload for the overlay.
   */
  async startSession(user: JwtPayload, lessonId: string, device: DeviceCtx) {
    const { lesson, course, student } = await this.resolveAccess(user.sub, user.role, lessonId);
    const watermarkId = this.newWatermarkId();

    // Teacher/admin preview: no PlaybackSession row (studentId is required and
    // they have no StudentProfile). A signed preview token carries pv=1 so the
    // key endpoint skips the DB session re-check.
    if (!student) {
      const previewSid = randomUUID();
      const creds = await this.drm.issueCredentials({
        assetId: lesson.videoAsset!.id,
        studentId: user.sub,
        sessionId: previewSid,
        watermarkId,
        preview: true,
      });
      return {
        playbackSessionId: previewSid,
        preview: true,
        scheme: creds.scheme,
        masterUrl: creds.masterUrl,
        keyUrl: creds.keyUrl,
        licenseServerUrl: creds.licenseServerUrl,
        durationSec: lesson.videoAsset!.durationSec,
        watermark: {
          studentId: user.sub,
          studentName: 'معاينة المعلم',
          studentPhone: '',
          watermarkId,
          sessionId: previewSid,
          issuedAt: new Date().toISOString(),
        } satisfies WatermarkPayload,
        stegToken: Buffer.from(`${previewSid}:${watermarkId}`).toString('base64url'),
      };
    }

    // Student: count the view / open the access window.
    const priorProgress = await this.prisma.lessonProgress.findUnique({
      where: { studentId_lessonId: { studentId: student.id, lessonId } },
      select: { lastPositionSec: true, watchedPct: true },
    });
    // Offer a resume point only if partway through (not near the end).
    const resumeAtSec =
      priorProgress && priorProgress.watchedPct < 95 && priorProgress.lastPositionSec > 5
        ? priorProgress.lastPositionSec
        : 0;
    await this.prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: student.id, lessonId } },
      update: { viewCount: { increment: 1 } },
      create: { studentId: student.id, lessonId, viewCount: 1, firstUnlockedAt: new Date() },
    });

    const session = await this.prisma.playbackSession.create({
      data: {
        watermarkId,
        studentId: student.id,
        lessonId,
        tenantId: course.tenantId,
        deviceSessionId: user.sessionId,
        ip: device.ip,
        userAgent: device.userAgent,
      },
    });

    await this.detectMultiIp(student.id, session.id, device.ip, course.tenantId);

    const creds = await this.drm.issueCredentials({
      assetId: lesson.videoAsset!.id,
      studentId: user.sub,
      sessionId: session.id,
      watermarkId,
    });

    const watermark: WatermarkPayload = {
      studentId: student.id,
      studentName: student.user.fullName,
      studentPhone: student.user.phone ?? '',
      watermarkId,
      sessionId: session.id,
      issuedAt: new Date().toISOString(),
    };

    return {
      playbackSessionId: session.id,
      preview: false,
      scheme: creds.scheme,
      masterUrl: creds.masterUrl,
      keyUrl: creds.keyUrl,
      licenseServerUrl: creds.licenseServerUrl,
      durationSec: lesson.videoAsset!.durationSec,
      resumeAtSec,
      watermark,
      // Steganographic token: embedded invisibly by the player where feasible;
      // resolves back to this exact session via leak-trace.
      stegToken: Buffer.from(`${session.id}:${watermarkId}`).toString('base64url'),
    };
  }

  private async detectMultiIp(
    studentId: string,
    currentSessionId: string,
    ip: string | undefined,
    tenantId: string,
  ) {
    if (!ip) return;
    // Other still-open sessions for this student in the last 15 minutes.
    const since = new Date(Date.now() - 15 * 60_000);
    const others = await this.prisma.playbackSession.findMany({
      where: {
        studentId,
        id: { not: currentSessionId },
        endedAt: null,
        startedAt: { gte: since },
      },
      select: { ip: true },
    });
    const distinctIps = new Set(others.map((o) => o.ip).filter(Boolean));
    distinctIps.add(ip);
    if (distinctIps.size > 1) {
      await this.flag('MULTI_IP_PLAYBACK', 'CRITICAL', {
        tenantId,
        studentId,
        meta: { ips: [...distinctIps], sessionId: currentSessionId },
      });
      await this.notifyStudentUserOf(studentId,
        'تنبيه أمني: تشغيل من أكثر من موقع',
        'رُصد تشغيل حسابك من أكثر من عنوان IP في نفس الوقت. إن لم يكن هذا أنت، غيّر كلمة المرور فوراً.');
    }
  }

  /** Append a telemetry event and run rapid-seek anomaly detection. */
  async heartbeat(
    user: JwtPayload,
    sessionId: string,
    body: { positionSec: number; type: string; watchedPct?: number },
    device: DeviceCtx,
  ) {
    const session = await this.assertOwnSession(user, sessionId);
    const events = Array.isArray(session.events) ? (session.events as any[]) : [];
    events.push({ t: Date.now(), type: body.type, pos: Math.round(body.positionSec) });

    // IP change mid-session is itself suspicious.
    if (device.ip && session.ip && device.ip !== session.ip) {
      await this.flag('MULTI_IP_PLAYBACK', 'CRITICAL', {
        tenantId: session.tenantId,
        studentId: session.studentId,
        meta: { from: session.ip, to: device.ip, sessionId },
      });
    }

    // Rapid-seek: many seeks in a short window ⇒ likely scripted scraping.
    const recentSeeks = events.filter(
      (e) => e.type === 'seek' && Date.now() - e.t < 10_000,
    ).length;
    if (recentSeeks >= 8) {
      await this.flag('RAPID_SEEK_ANOMALY', 'WARNING', {
        tenantId: session.tenantId,
        studentId: session.studentId,
        meta: { sessionId, recentSeeks },
      });
    }

    await this.prisma.playbackSession.update({
      where: { id: sessionId },
      data: { events: events.slice(-500) },
    });

    // Persist watch progress.
    if (body.watchedPct != null) {
      const justCompleted = body.watchedPct >= 90;
      await this.prisma.lessonProgress.updateMany({
        where: { studentId: session.studentId, lessonId: session.lessonId },
        data: {
          lastPositionSec: Math.round(body.positionSec),
          watchedPct: Math.max(0, Math.min(100, Math.round(body.watchedPct))),
          ...(justCompleted ? { completedAt: new Date() } : {}),
        },
      });
      // Finishing a lesson may complete the whole course → issue a certificate.
      if (justCompleted) {
        await this.certificates.checkByLesson(session.studentId, session.lessonId);
      }
    }

    // Learning activity rolls the daily streak (same-day is a no-op).
    await this.progress.touchActivity(session.studentId);
    return { ok: true };
  }

  /** Client-side hardening signal (devtools open, etc.) → SecurityEvent. */
  async reportEvent(
    user: JwtPayload,
    sessionId: string,
    body: { type: string; meta?: Record<string, unknown> },
  ) {
    const session = await this.assertOwnSession(user, sessionId);
    const map: Record<string, 'DEVTOOLS_DETECTED' | 'MANUAL_FLAG'> = {
      devtools: 'DEVTOOLS_DETECTED',
    };
    const type = map[body.type] ?? 'MANUAL_FLAG';
    await this.flag(type, type === 'DEVTOOLS_DETECTED' ? 'WARNING' : 'INFO', {
      tenantId: session.tenantId,
      studentId: session.studentId,
      meta: { ...body.meta, sessionId, clientType: body.type },
    });
    return { ok: true };
  }

  async endSession(user: JwtPayload, sessionId: string) {
    await this.assertOwnSession(user, sessionId);
    await this.prisma.playbackSession.updateMany({
      where: { id: sessionId, endedAt: null },
      data: { endedAt: new Date() },
    });
    return { ok: true };
  }

  private async assertOwnSession(user: JwtPayload, sessionId: string) {
    const session = await this.prisma.playbackSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Playback session not found');
    // A student may only touch their own sessions.
    if (user.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({ where: { userId: user.sub } });
      if (!student || student.id !== session.studentId) {
        throw new ForbiddenException('Not your playback session');
      }
    }
    return session;
  }

  private async flag(
    type:
      | 'MULTI_IP_PLAYBACK'
      | 'VIEW_CAP_EXCEEDED'
      | 'RAPID_SEEK_ANOMALY'
      | 'DEVTOOLS_DETECTED'
      | 'MANUAL_FLAG',
    severity: 'INFO' | 'WARNING' | 'CRITICAL',
    data: { tenantId?: string; studentId?: string; meta?: Record<string, unknown> },
  ) {
    await this.prisma.securityEvent.create({
      data: {
        type,
        severity,
        tenantId: data.tenantId,
        studentId: data.studentId,
        meta: (data.meta ?? {}) as any,
      },
    });
    // Notify the tenant teacher on serious events.
    if ((severity === 'CRITICAL' || type === 'VIEW_CAP_EXCEEDED') && data.tenantId) {
      const teacher = await this.prisma.teacherProfile.findUnique({
        where: { id: data.tenantId },
        select: { userId: true },
      });
      if (teacher) {
        await this.notifications.create({
          userId: teacher.userId,
          type: 'SECURITY_ALERT',
          title: 'تنبيه أمني في محتواك',
          body: `رُصد نشاط مشبوه (${type}) لأحد الطلاب.`,
          meta: data.meta ?? {},
        });
      }
    }
  }

  private async notifyStudentUserOf(studentId: string, title: string, bodyText: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { id: studentId },
      select: { userId: true },
    });
    if (student) {
      await this.notifications.create({
        userId: student.userId,
        type: 'SECURITY_ALERT',
        title,
        body: bodyText,
      });
    }
  }
}
