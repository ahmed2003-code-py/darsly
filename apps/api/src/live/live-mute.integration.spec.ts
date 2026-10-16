import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { classroom, classroomWorld, codeOf, enterRoom, OFFER } from './testing/classroom';

/**
 * Mute that keeps the microphone sent, on a real PostgreSQL: the sender's
 * page switches the track off in place (instant), the server only tells the
 * room. The track stays published and pulled — so unmuting is instant on both
 * ends — but everyone's list shows the microphone off, and the time a
 * student held a muted microphone is not counted as speaking.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveRtcTrack']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

type C = ReturnType<typeof classroom>;
async function sendMic(c: C, lsId: string, userId: string, muted?: boolean) {
  const { connectionId } = await c.rtc.openConnection(userId, lsId, 'SEND');
  await c.rtc.publish(userId, lsId, connectionId, {
    offer: OFFER,
    tracks: [{ mid: '0', kind: 'AUDIO', ...(muted ? { muted } : {}) }],
  });
  const t = await prisma.liveRtcTrack.findFirstOrThrow({
    where: { connectionId, kind: 'AUDIO' },
    select: { id: true, trackName: true },
  });
  return { connectionId, ...t };
}
/** The room's push is coalesced (BROADCAST_COALESCE_MS): wait it out. */
const settle = () => new Promise((r) => setTimeout(r, 600));
const audioOf = async (c: C, lsId: string, viewer: string, who: string) =>
  (await c.rtc.state(viewer, lsId)).participants.find((p) => p.userId === who)?.audio;

describe('a microphone muted in place', () => {
  it('muting shows it off to everyone, keeps it sent and pulled; unmuting shows it on again', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.teacher.id, 'TEACHER');
    await enterRoom(prisma, c, w, w.s[0].id);
    const mic = await sendMic(c, w.ls.id, w.teacher.id);
    expect(await audioOf(c, w.ls.id, w.s[0].id, w.teacher.id)).toBe(true);

    c.events.length = 0;
    expect(
      await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: true }),
    ).toEqual({
      muted: true,
    });
    // The room is told (the socket push the pages listen for).
    await settle();
    expect(c.events).toContainEqual(expect.objectContaining({ event: 'live:rtc-state' }));
    expect(await audioOf(c, w.ls.id, w.s[0].id, w.teacher.id)).toBe(false);
    // Still published at the SFU and still in the list a student pulls from.
    expect(c.sfu.active(mic.trackName)).toBe(true);
    const st = await c.rtc.state(w.s[0].id, w.ls.id);
    expect(st.tracks.find((t) => t.id === mic.id)).toMatchObject({ muted: true });

    await new Promise((r) => setTimeout(r, 30));
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: false });
    expect(await audioOf(c, w.ls.id, w.s[0].id, w.teacher.id)).toBe(true);
    const row = await prisma.liveRtcTrack.findUniqueOrThrow({ where: { id: mic.id } });
    expect(row.mutedAt).toBeNull();
    expect(row.mutedMs).toBeGreaterThan(0);
  });

  it('the same mute twice changes nothing and tells nobody twice', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.teacher.id, 'TEACHER');
    const mic = await sendMic(c, w.ls.id, w.teacher.id);
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: true });
    const first = (await prisma.liveRtcTrack.findUniqueOrThrow({ where: { id: mic.id } })).mutedAt;
    await settle();
    c.events.length = 0;
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: true });
    await settle();
    expect(c.events.filter((e) => e.event === 'live:rtc-state')).toHaveLength(0);
    expect(
      (await prisma.liveRtcTrack.findUniqueOrThrow({ where: { id: mic.id } })).mutedAt,
    ).toEqual(first);
    // Unmuting what is not muted is nothing either.
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: false });
    await settle();
    c.events.length = 0;
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: false });
    await settle();
    expect(c.events.filter((e) => e.event === 'live:rtc-state')).toHaveLength(0);
  });

  it('a microphone sent muted (joined muted) shows off from the start', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.teacher.id, 'TEACHER');
    await enterRoom(prisma, c, w, w.s[0].id);
    const mic = await sendMic(c, w.ls.id, w.teacher.id, true);
    expect(await audioOf(c, w.ls.id, w.s[0].id, w.teacher.id)).toBe(false);
    expect(c.sfu.active(mic.trackName)).toBe(true);
    await c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: false });
    expect(await audioOf(c, w.ls.id, w.s[0].id, w.teacher.id)).toBe(true);
  });

  it('only my own sent microphone or camera — never someone else’s, a screen, or a closed track', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.teacher.id, 'TEACHER');
    const mic = await sendMic(c, w.ls.id, w.teacher.id);
    // Someone else's connection.
    expect(
      await codeOf(c.rtc.setMuted(w.s[0].id, w.ls.id, mic.connectionId, { mid: '0', muted: true })),
    ).not.toBe('ok');
    // A screen share is stopped, not muted.
    await c.rtc.publish(w.teacher.id, w.ls.id, mic.connectionId, {
      offer: OFFER,
      tracks: [{ mid: '1', kind: 'SCREEN' }],
    });
    expect(
      await codeOf(
        c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '1', muted: true }),
      ),
    ).toBe('RTC_TRACKS_GONE');
    // A track already closed.
    await c.rtc.closeTracks(w.teacher.id, w.ls.id, mic.connectionId, { mids: ['0'] });
    expect(
      await codeOf(
        c.rtc.setMuted(w.teacher.id, w.ls.id, mic.connectionId, { mid: '0', muted: true }),
      ),
    ).toBe('RTC_TRACKS_GONE');
  });

  it('a student’s muted time is not counted as speaking', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.s[0].id);
    await c.rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const mic = await sendMic(c, w.ls.id, w.s[0].id);
    // Opened 120 s ago, muted for the last 90 of them: 30 s spoken.
    const now = Date.now();
    await prisma.liveRtcTrack.update({
      where: { id: mic.id },
      data: { createdAt: new Date(now - 120_000), mutedAt: new Date(now - 90_000) },
    });
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { startedAt: new Date(now - 300_000) },
    });
    const r = await c.live.attendanceFor(w.scope, w.ls.id);
    const row = r.rows.find((x: { userId: string }) => x.userId === w.s[0].id) as
      { micOpenSeconds: number } | undefined;
    expect(row?.micOpenSeconds).toBeGreaterThanOrEqual(28);
    expect(row?.micOpenSeconds).toBeLessThanOrEqual(32);
  });
});
