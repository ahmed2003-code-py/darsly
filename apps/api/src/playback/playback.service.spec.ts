import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IDrmProvider } from '../video/drm/drm.provider';
import { PlaybackService } from './playback.service';

/** Minimal Prisma mock: each model gets jest.fn() methods we can program. */
function makePrisma(overrides: any = {}) {
  const base: any = {
    // The service moved to findFirst when soft-delete filtering was added
    // (a deleted lesson/unit/course must not play). Both names share one mock so
    // the tests below keep programming it as `lesson.findUnique`.
    lesson: (() => {
      const findLesson = jest.fn();
      return { findUnique: findLesson, findFirst: findLesson };
    })(),
    teacherProfile: { findUnique: jest.fn() },
    studentProfile: { findUnique: jest.fn() },
    enrollment: { findUnique: jest.fn() },
    lessonProgress: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
    playbackSession: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    securityEvent: { create: jest.fn().mockResolvedValue({}) },
    notification: { create: jest.fn().mockResolvedValue({}) },
    videoAsset: { findUnique: jest.fn() },
  };
  for (const k of Object.keys(overrides)) base[k] = { ...base[k], ...overrides[k] };
  return base;
}

const drm: IDrmProvider = {
  scheme: 'AES_128_CLEARKEY',
  hardwareBacked: false,
  package: jest.fn(),
  issueCredentials: jest.fn().mockResolvedValue({
    scheme: 'AES_128_CLEARKEY',
    masterUrl: '/api/v1/playback/hls/tok/master.m3u8',
    keyUrl: '/api/v1/playback/key/tok',
  }),
};

const studentUser: JwtPayload = { sub: 'u1', role: Role.STUDENT, sessionId: 'dev1' };
const progressMock: any = { touchActivity: jest.fn().mockResolvedValue(undefined) };
const notifMock: any = { create: jest.fn().mockResolvedValue({}), pushUnread: jest.fn().mockResolvedValue(0) };
const gamificationMock: any = {
  record: jest.fn().mockResolvedValue({ awarded: false, xp: 0, coins: 0, totalXp: 0, level: 1, leveledUp: false, achievements: [], missions: [] }),
  checkUnitCompletion: jest.fn().mockResolvedValue({ awarded: false }),
  noteStudySession: jest.fn().mockResolvedValue(undefined),
  checkStreakMilestone: jest.fn().mockResolvedValue({ awarded: false }),
};
const certMock: any = { checkByLesson: jest.fn().mockResolvedValue(null) };

const readyLesson = (over: any = {}) => ({
  id: 'l1',
  isFreePreview: false,
  dripUnlockAt: null,
  dripAfterEnrollDays: null,
  accessWindowDays: null,
  viewsCap: null,
  videoAsset: { id: 'asset1', status: 'READY', durationSec: 42 },
  unit: { course: { id: 'c1', tenantId: 't1', accessWindowDays: null, defaultViewsCap: null } },
  ...over,
});

describe('PlaybackService', () => {
  describe('watermark ids', () => {
    it('formats as DRS-<5digits>-<4hex>', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ isFreePreview: true }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        user: { fullName: 'أحمد', phone: '+2010' },
      });
      prisma.lessonProgress.upsert.mockResolvedValue({});
      prisma.playbackSession.create.mockResolvedValue({ id: 'ps1', watermarkId: 'x' });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      const ticket = await svc.startSession(studentUser, 'l1', { ip: '1.1.1.1' });
      expect(ticket.watermark.watermarkId).toMatch(/^DRS-\d{5}-[0-9A-F]{4}$/);
      expect(ticket.watermark.studentName).toBe('أحمد');
      expect(ticket.stegToken).toBeTruthy();
    });
  });

  describe('access control', () => {
    it('allows a free-preview lesson without enrollment', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ isFreePreview: true }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.lessonProgress.upsert.mockResolvedValue({});
      prisma.playbackSession.create.mockResolvedValue({ id: 'ps1' });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).resolves.toHaveProperty('masterUrl');
    });

    it('blocks a paid lesson when not enrolled', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson());
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.enrollment.findUnique.mockResolvedValue(null);
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks a drip-locked lesson (N days after enroll)', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ dripAfterEnrollDays: 7 }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.enrollment.findUnique.mockResolvedValue({
        status: 'ACTIVE', expiresAt: null, approvedAt: new Date(), // enrolled today
      });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).rejects.toThrow(/not unlocked/i);
    });

    it('enforces the views cap and flags it', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ isFreePreview: true, viewsCap: 2 }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.lessonProgress.findUnique.mockResolvedValue({ viewCount: 2 });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).rejects.toThrow(/maximum number of views/i);
      expect(prisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'VIEW_CAP_EXCEEDED' }) }),
      );
    });

    it('rejects a lesson whose video is not READY (after access granted)', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(
        readyLesson({ isFreePreview: true, videoAsset: { id: 'a', status: 'PROCESSING' } }),
      );
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('multi-IP detection', () => {
    it('flags CRITICAL when another open session uses a different IP', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ isFreePreview: true }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.lessonProgress.upsert.mockResolvedValue({});
      prisma.playbackSession.create.mockResolvedValue({ id: 'ps2' });
      prisma.playbackSession.findMany.mockResolvedValue([{ ip: '9.9.9.9' }]); // other open session
      prisma.teacherProfile.findUnique.mockResolvedValue({ userId: 'teacherUser' });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      await svc.startSession(studentUser, 'l1', { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'MULTI_IP_PLAYBACK', severity: 'CRITICAL' }) }),
      );
    });
  });

  describe('heartbeat anomalies', () => {
    /** A session whose telemetry already holds `seeks` deliberate seeks, now. */
    function sessionSeeking(prisma: any, seeks: number, extra: any[] = []) {
      const now = Date.now();
      const events = [
        ...Array.from({ length: seeks }, () => ({ t: now, type: 'seek', pos: 1 })),
        ...extra,
      ];
      prisma.playbackSession.findUnique.mockResolvedValue({
        id: 'ps1', studentId: 's1', tenantId: 't1', lessonId: 'l1', ip: '1.1.1.1', events,
      });
      prisma.studentProfile.findUnique.mockResolvedValue({ id: 's1' });
      prisma.playbackSession.update.mockResolvedValue({});
      prisma.lessonProgress.updateMany.mockResolvedValue({});
      return new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
    }
    const rapidSeek = expect.objectContaining({
      data: expect.objectContaining({ type: 'RAPID_SEEK_ANOMALY' }),
    });

    it('flags rapid-seek scraping', async () => {
      const prisma = makePrisma();
      const svc = sessionSeeking(prisma, 12);
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 5, type: 'seek' }, { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).toHaveBeenCalledWith(rapidSeek);
    });

    // A student skimming a lesson drags the bar a handful of times. That is
    // what the old bar of eight caught, and it is not scraping.
    it('leaves an ordinary burst of seeking alone', async () => {
      const prisma = makePrisma();
      const svc = sessionSeeking(prisma, 8);
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 5, type: 'seek' }, { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).not.toHaveBeenCalledWith(rapidSeek);
    });

    // One burst is one alert. Every seek after the twelfth used to raise its
    // own, so a single drag filled the teacher's security screen.
    it('says it once per session', async () => {
      const prisma = makePrisma();
      const svc = sessionSeeking(prisma, 20, [{ t: Date.now(), type: 'rapid-seek-flagged' }]);
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 5, type: 'seek' }, { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).not.toHaveBeenCalledWith(rapidSeek);
    });
  });

  /**
   * The rule that was broken in production: watch time was measured from
   * `session.startedAt`, so a student who resumed or scrubbed restarted from a
   * ceiling of zero. Real rows sat at position 200 of a 201-second lesson,
   * recorded as 22% watched, never completed, never paid.
   */
  describe('watch credit', () => {
    function watching(over: Partial<any> = {}) {
      const prisma = makePrisma();
      prisma.playbackSession.findUnique.mockResolvedValue({
        id: 'ps1', studentId: 's1', tenantId: 't1', lessonId: 'l1', ip: '1.1.1.1', events: [],
        startedAt: new Date(Date.now() - 20_000),
        lastBeatAt: new Date(Date.now() - 10_000),
        lastPosSec: 100,
        ...over,
      });
      prisma.studentProfile.findUnique.mockResolvedValue({ id: 's1' });
      prisma.playbackSession.update.mockResolvedValue({});
      prisma.lessonProgress.updateMany.mockResolvedValue({ count: 1 });
      prisma.lesson.findUnique.mockResolvedValue({
        durationSec: 200, unit: { courseId: 'c1' }, videoAsset: { durationSec: 200 },
      });
      const svc = new PlaybackService(prisma, drm, progressMock, gamificationMock, notifMock, certMock);
      return { svc, prisma };
    }
    const progressWrite = (prisma: any) => prisma.lessonProgress.updateMany.mock.calls.at(-1)[0].data;

    it('credits the content watched since the previous beat', async () => {
      const { svc, prisma } = watching();
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 100 });
      // 10 seconds of real time, 10 seconds of content advanced.
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 110, type: 'hb', watchedPct: 55 }, {});
      expect(progressWrite(prisma).watchedSec).toBe(110);
      expect(progressWrite(prisma).watchedPct).toBe(55);
    });

    it('credits nothing for seeking to the end', async () => {
      const { svc, prisma } = watching();
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 20 });
      // Playhead jumps 100 seconds, but only 10 seconds of real time passed.
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 200, type: 'seek', watchedPct: 100 }, {});
      const data = progressWrite(prisma);
      // 10s real time × 2.5 max rate = 25s creditable, not the 100s claimed.
      expect(data.watchedSec).toBe(45);
      expect(data.completedAt).toBeUndefined();
    });

    it('ignores a forged watchedPct entirely', async () => {
      const { svc, prisma } = watching();
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 0 });
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 101, type: 'hb', watchedPct: 100 }, {});
      // One second of content advanced is one second credited, whatever the
      // client claims about the percentage.
      expect(progressWrite(prisma).watchedSec).toBe(1);
      expect(progressWrite(prisma).completedAt).toBeUndefined();
    });

    it('accumulates across sessions, so a resumed lesson can finish', async () => {
      // A fresh session — the ceiling that used to reset and make completion
      // unreachable — carrying 170 of 200 seconds already earned earlier.
      const { svc, prisma } = watching({ startedAt: new Date(), lastBeatAt: new Date(Date.now() - 8_000), lastPosSec: 170 });
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 170 });
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 180, type: 'hb', watchedPct: 90 }, {});
      const data = progressWrite(prisma);
      expect(data.watchedSec).toBe(180); // 170 + 10
      expect(data.completedAt).toBeInstanceOf(Date); // 180/200 = 90%
      expect(gamificationMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LESSON_COMPLETED', key: 'LESSON_COMPLETED:s1:l1' }),
      );
    });

    it('completes on a genuine end-of-video at the kinder bar', async () => {
      const { svc, prisma } = watching({ lastBeatAt: new Date(Date.now() - 5_000), lastPosSec: 145 });
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 145 });
      // 150/200 = 75%: short of the 90% rule, past the 70% end-of-video bar.
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 150, type: 'ended', watchedPct: 100 }, {});
      expect(progressWrite(prisma).completedAt).toBeInstanceOf(Date);
    });

    it('still refuses an `ended` that was never watched', async () => {
      const { svc, prisma } = watching({ lastBeatAt: new Date(Date.now() - 2_000), lastPosSec: 0 });
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 0 });
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 200, type: 'ended', watchedPct: 100 }, {});
      const data = progressWrite(prisma);
      expect(data.watchedSec).toBe(5); // 2s of real time, nothing more
      expect(data.completedAt).toBeUndefined();
    });

    it('falls back to the video asset when the lesson has no duration', async () => {
      const { svc, prisma } = watching({ lastBeatAt: new Date(Date.now() - 10_000), lastPosSec: 170 });
      prisma.lesson.findUnique.mockResolvedValue({
        durationSec: 0, unit: { courseId: 'c1' }, videoAsset: { durationSec: 200 },
      });
      prisma.lessonProgress.findUnique.mockResolvedValue({ watchedSec: 175 });
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 180, type: 'hb', watchedPct: 90 }, {});
      // Without the fallback this lesson could never complete at all.
      expect(progressWrite(prisma).completedAt).toBeInstanceOf(Date);
    });
  });
});
