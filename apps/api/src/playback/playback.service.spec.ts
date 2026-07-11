import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtPayload, Role } from '@darsly/shared-types';
import { IDrmProvider } from '../video/drm/drm.provider';
import { PlaybackService } from './playback.service';

/** Minimal Prisma mock: each model gets jest.fn() methods we can program. */
function makePrisma(overrides: any = {}) {
  const base: any = {
    lesson: { findUnique: jest.fn() },
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
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
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
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).resolves.toHaveProperty('masterUrl');
    });

    it('blocks a paid lesson when not enrolled', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson());
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.enrollment.findUnique.mockResolvedValue(null);
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
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
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
      await expect(svc.startSession(studentUser, 'l1', {})).rejects.toThrow(/not unlocked/i);
    });

    it('enforces the views cap and flags it', async () => {
      const prisma = makePrisma();
      prisma.lesson.findUnique.mockResolvedValue(readyLesson({ isFreePreview: true, viewsCap: 2 }));
      prisma.studentProfile.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', user: { fullName: 'A', phone: '' },
      });
      prisma.lessonProgress.findUnique.mockResolvedValue({ viewCount: 2 });
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
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
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
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
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
      await svc.startSession(studentUser, 'l1', { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'MULTI_IP_PLAYBACK', severity: 'CRITICAL' }) }),
      );
    });
  });

  describe('heartbeat anomalies', () => {
    it('flags rapid-seek scraping', async () => {
      const prisma = makePrisma();
      const now = Date.now();
      const events = Array.from({ length: 8 }, () => ({ t: now, type: 'seek', pos: 1 }));
      prisma.playbackSession.findUnique.mockResolvedValue({
        id: 'ps1', studentId: 's1', tenantId: 't1', lessonId: 'l1', ip: '1.1.1.1', events,
      });
      prisma.studentProfile.findUnique.mockResolvedValue({ id: 's1' });
      prisma.playbackSession.update.mockResolvedValue({});
      prisma.lessonProgress.updateMany.mockResolvedValue({});
      const svc = new PlaybackService(prisma, drm, progressMock, notifMock, certMock);
      await svc.heartbeat(studentUser, 'ps1', { positionSec: 5, type: 'seek' }, { ip: '1.1.1.1' });
      expect(prisma.securityEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'RAPID_SEEK_ANOMALY' }) }),
      );
    });
  });
});
