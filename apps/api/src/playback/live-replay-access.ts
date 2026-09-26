import { UnauthorizedException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { PlaybackClaims } from './signed-url.service';

type Db = Pick<
  PrismaClient,
  'liveReplaySession' | 'deviceSession' | 'academyMembership' | 'studentProfile' | 'liveBooking'
>;

/**
 * The key endpoint's check for a live lesson's recording (token rt='L').
 *
 * The token already pins one asset and expires; this is the part a token
 * cannot carry — whether the viewing is still open and the viewer may still
 * watch. The same rules LiveReplayService applied when the replay started
 * (LiveService.assertInSession + the recording's visibility), asked again:
 *  - the LiveReplaySession exists, is not ended or expired, and matches the
 *    token (user, asset, watermark);
 *  - its device session has not been revoked;
 *  - the class has not been deleted;
 *  - the teacher side is still the class's teacher or active staff of its
 *    academy; a student is still booked AND the recording is still shared.
 * Anything else: no key, so nothing decrypts.
 */
export async function assertLiveReplayKey(db: Db, claims: PlaybackClaims): Promise<void> {
  const deny = (why: string) => {
    throw new UnauthorizedException(why);
  };
  const r = await db.liveReplaySession.findUnique({
    where: { id: claims.sid },
    include: {
      liveSession: {
        select: {
          id: true,
          deletedAt: true,
          recordingVisibility: true,
          academyId: true,
          tenantId: true,
          teacher: { select: { userId: true } },
        },
      },
    },
  });
  if (!r || r.endedAt) return deny('Replay not active');
  if (r.expiresAt.getTime() < Date.now()) return deny('Replay expired');
  if (r.watermarkId !== claims.wm || r.userId !== claims.uid || r.videoAssetId !== claims.aid) {
    return deny('Token mismatch');
  }
  if (r.deviceSessionId) {
    const dev = await db.deviceSession.findUnique({
      where: { id: r.deviceSessionId },
      select: { revokedAt: true },
    });
    if (dev?.revokedAt) return deny('Device revoked');
  }
  const s = r.liveSession;
  if (s.deletedAt) return deny('Session removed');
  if (r.role === 'TEACHER') {
    if (s.teacher.userId === r.userId) return;
    const staff = await db.academyMembership.findFirst({
      where: {
        academyId: s.academyId ?? s.tenantId,
        userId: r.userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] },
      },
      select: { id: true },
    });
    if (!staff) return deny('No longer staff');
    return;
  }
  if (s.recordingVisibility !== 'STUDENTS') return deny('Recording not shared');
  const student = await db.studentProfile.findUnique({
    where: { userId: r.userId },
    select: { id: true },
  });
  const booked =
    student &&
    (await db.liveBooking.findUnique({
      where: { sessionId_studentId: { sessionId: s.id, studentId: student.id } },
      select: { id: true },
    }));
  if (!booked) return deny('Not in this session');
}
