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
import { GamificationService } from '../gamification/gamification.service';
import { GamificationOutcome } from '../gamification/gamification.types';

/** Content-seconds creditable per second of real time (2x playback + jitter). */
const MAX_PLAYBACK_RATE = 2.5;
/** Share of a lesson that must be genuinely consumed to complete it. */
const WATCHED_COMPLETE_PCT = 90;
/** The kinder bar applied when the player reports the video actually ended. */
const ENDED_COMPLETE_PCT = 70;
/**
 * Written into a session's own telemetry once it has raised a rapid-seek alert.
 * It rides along with the events the heartbeat already loads and writes back,
 * so "say this once per session" costs no extra query.
 */
const RAPID_SEEK_MARK = 'rapid-seek-flagged';

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
    private readonly gamification: GamificationService,
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
    // findFirst (not findUnique) so the soft-delete middleware filters the
    // lesson; the nested unit/course are checked explicitly (nested includes
    // are not auto-filtered) — a "deleted" lesson/unit/course must not play.
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      include: {
        videoAsset: true,
        unit: { include: { course: true } },
      },
    });
    if (!lesson || lesson.unit.deletedAt || lesson.unit.course.deletedAt) {
      throw new NotFoundException('Lesson not found');
    }
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
    const { lesson, course, student, viewsCap } = await this.resolveAccess(user.sub, user.role, lessonId);
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
    // With a cap, the increment is conditional on still being under it — the
    // read in resolveAccess and this write are not one step, and two plays
    // started together used to both count as "one under the cap".
    if (viewsCap != null && priorProgress) {
      const took = await this.prisma.lessonProgress.updateMany({
        where: { studentId: student.id, lessonId, viewCount: { lt: viewsCap } },
        data: { viewCount: { increment: 1 } },
      });
      if (took.count === 0) {
        throw new ForbiddenException('You have reached the maximum number of views for this lesson');
      }
    } else {
      await this.prisma.lessonProgress.upsert({
        where: { studentId_lessonId: { studentId: student.id, lessonId } },
        update: { viewCount: { increment: 1 } },
        create: { studentId: student.id, lessonId, viewCount: 1, firstUnlockedAt: new Date() },
      });
    }

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
    //
    // Two things kept this firing at ordinary students. The player used to
    // report every `seeked` the browser raised — including hls.js nudging past
    // a buffer hole on a weak connection, which is not the student touching
    // anything — and one burst raised a fresh alert on every seek after the
    // eighth, so a single drag of the bar filled the teacher's screen. Only
    // deliberate seeks are reported now, the bar is higher, and a session says
    // this at most once.
    const alreadyFlagged = events.some((e) => e.type === RAPID_SEEK_MARK);
    const recentSeeks = alreadyFlagged
      ? 0
      : events.filter((e) => e.type === 'seek' && Date.now() - e.t < 10_000).length;
    if (recentSeeks >= 12) {
      events.push({ t: Date.now(), type: RAPID_SEEK_MARK });
      await this.flag('RAPID_SEEK_ANOMALY', 'WARNING', {
        tenantId: session.tenantId,
        studentId: session.studentId,
        meta: { sessionId, recentSeeks },
      });
    }

    // The beat marker rides along with the telemetry write — heartbeats are the
    // highest-frequency write in the product, and this is every 9 seconds per
    // watching student.
    const beatAt = new Date();
    await this.prisma.playbackSession.update({
      where: { id: sessionId },
      data: {
        events: events.slice(-500),
        lastBeatAt: beatAt,
        lastPosSec: Math.round(body.positionSec),
      },
    });

    // Persist watch progress. The client-reported watchedPct is NEVER trusted for
    // Progress is credited, not reported.
    //
    // The client says where the playhead is; the server decides how much of
    // that counts. Each heartbeat may credit only as much content as the real
    // time since the previous heartbeat allows, so seeking to the end credits
    // nothing and a forged position credits nothing either.
    //
    // Crucially the total accumulates on the LessonProgress row, across every
    // session. The previous rule measured against `session.startedAt`, which
    // meant a student who resumed a lesson — or scrubbed at all — restarted
    // from a ceiling of zero and could never reach completion: production had
    // rows sitting at position 200 of a 201-second lesson, recorded as 22%
    // watched and never completed.
    //
    // Only the student's own player writes their progress. Staff in the tenant
    // may end or flag a session, but must never be able to complete a lesson —
    // and so a course, and so a certificate — on a student's behalf.
    let gamification: GamificationOutcome | undefined;
    if (body.watchedPct != null && user.role === Role.STUDENT) {
      const lesson = await this.prisma.lesson.findUnique({
        where: { id: session.lessonId },
        select: {
          durationSec: true,
          unit: { select: { courseId: true } },
          videoAsset: { select: { durationSec: true } },
        },
      });
      // Some lessons carry a duration only on the video asset; without this
      // fallback those lessons can never complete at all.
      const durationSec = lesson?.durationSec || lesson?.videoAsset?.durationSec || 0;
      const position = Math.round(body.positionSec);

      const progress = await this.prisma.lessonProgress.findUnique({
        where: { studentId_lessonId: { studentId: session.studentId, lessonId: session.lessonId } },
        select: { watchedSec: true },
      });

      const sinceLastBeatSec = session.lastBeatAt
        ? (beatAt.getTime() - session.lastBeatAt.getTime()) / 1000
        : 0;
      const advancedSec = Math.max(0, position - session.lastPosSec);
      // At most MAX_RATE seconds of content per second of real time — enough
      // for 2x playback plus jitter, and no constant grace, so spamming
      // heartbeats earns nothing that waiting would not have earned anyway.
      const credited = Math.min(advancedSec, Math.max(0, sinceLastBeatSec) * MAX_PLAYBACK_RATE);
      const watchedSec = Math.min(
        durationSec || Number.MAX_SAFE_INTEGER,
        (progress?.watchedSec ?? 0) + Math.floor(credited),
      );

      const effectivePct =
        durationSec > 0 ? Math.min(100, Math.floor((watchedSec / durationSec) * 100)) : 0;
      // Reaching the true end of the video is itself evidence, so an `ended`
      // event completes on a lower bar — a few seconds lost to buffering
      // should not cost a student the lesson they just sat through.
      const threshold = body.type === 'ended' ? ENDED_COMPLETE_PCT : WATCHED_COMPLETE_PCT;
      const justCompleted = durationSec > 0 && effectivePct >= threshold;

      await this.prisma.lessonProgress.updateMany({
        where: { studentId: session.studentId, lessonId: session.lessonId },
        data: {
          lastPositionSec: position,
          watchedSec,
          // Monotonic: scrubbing backwards must not walk a progress bar back.
          watchedPct: effectivePct,
          ...(justCompleted ? { completedAt: new Date() } : {}),
        },
      });
      // Finishing a lesson may complete the whole course → issue a certificate.
      if (justCompleted) {
        await this.certificates.checkByLesson(session.studentId, session.lessonId);
        // The heartbeat keeps reporting ≥90% for the rest of the session, so
        // this runs many times per lesson — and pays once, because the key is
        // the lesson, not the request.
        gamification = await this.gamification.record({
          studentId: session.studentId,
          type: 'LESSON_COMPLETED',
          key: `LESSON_COMPLETED:${session.studentId}:${session.lessonId}`,
          tenantId: session.tenantId,
          courseId: lesson?.unit.courseId,
          entityType: 'lesson',
          entityId: session.lessonId,
          meta: { watchedPct: effectivePct },
        });
        if (gamification.awarded) {
          await this.gamification.noteStudySession(session.studentId);
          await this.gamification.checkUnitCompletion(session.studentId, session.lessonId);
        }
      }
    }

    // Learning activity rolls the daily streak (same-day is a no-op).
    const streak = await this.progress.touchActivity(session.studentId);
    if (streak?.rolled) await this.gamification.checkStreakMilestone(session.studentId, streak.currentStreak);
    // Only present on the heartbeat that actually earned something, so the
    // player can celebrate in the same round trip instead of polling for it.
    return gamification?.awarded ? { ok: true, gamification } : { ok: true };
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
    // Super admin may touch any session; everyone else is scoped.
    if (user.role === Role.SUPER_ADMIN) return session;
    // A student may only touch their own sessions.
    if (user.role === Role.STUDENT) {
      const student = await this.prisma.studentProfile.findUnique({ where: { userId: user.sub } });
      if (!student || student.id !== session.studentId) {
        throw new ForbiddenException('Not your playback session');
      }
      return session;
    }
    // A teacher may only touch sessions inside their own tenant (never
    // cross-tenant). Teacher preview never creates a DB session, so this only
    // guards against tampering with another tenant's student sessions.
    if (user.role === Role.TEACHER) {
      if (session.tenantId !== user.tenantId) {
        throw new ForbiddenException('Not your playback session');
      }
      return session;
    }
    throw new ForbiddenException('Not your playback session');
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
