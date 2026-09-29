import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { classroom, classroomWorld, codeOf, OFFER, type ClassroomWorld } from './testing/classroom';

/**
 * Live V1 Phase B on a real PostgreSQL: who may run a class. One rule
 * (LiveService.canModerate): the session's own teacher, or `live.manage` in
 * the academy as the academy's resolver computes it. Being staff — an
 * ASSISTANT in particular — is not enough.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'academyMembership', 'liveHand']);
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

/** A staff member of the class's academy, with an approved teacher identity. */
async function staff(
  w: ClassroomWorld,
  role: 'OWNER' | 'TEACHER' | 'ASSISTANT',
  opts: { permissions?: string[]; courseScope?: 'ALL' | 'SELECTED'; status?: 'ACTIVE' | 'LEFT' } = {},
) {
  const k = randomUUID().slice(0, 8);
  const u = await prisma.user.create({ data: { role: 'TEACHER', fullName: `${role} ${k}`, email: `mod-${k}@it.test` } });
  await prisma.teacherProfile.create({ data: { userId: u.id, slug: `mod-${k}`, status: 'APPROVED' } });
  await prisma.academyMembership.create({
    data: {
      userId: u.id,
      academyId: w.tp.id,
      role,
      status: opts.status ?? 'ACTIVE',
      joinedAt: new Date(),
      permissions: opts.permissions ?? [],
      courseScope: opts.courseScope ?? 'ALL',
    },
  });
  return u;
}

describe('the moderation rule', () => {
  it('matrix: who may run the class', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    const cases: [string, string, boolean][] = [
      ['session teacher', w.teacher.id, true],
      ['another OWNER member', (await staff(w, 'OWNER')).id, true],
      ['a TEACHER member (live.manage by role)', (await staff(w, 'TEACHER')).id, true],
      ['an ASSISTANT with no grants', w.assistant.id, false],
      ['an ASSISTANT granted live.manage', (await staff(w, 'ASSISTANT', { permissions: ['live.manage'] })).id, true],
      ['an ASSISTANT granted other things', (await staff(w, 'ASSISTANT', { permissions: ['student.view', 'chat.moderate'] })).id, false],
      // live.manage is academy-wide: an assistant limited to some courses loses it.
      ['a course-scoped ASSISTANT granted live.manage', (await staff(w, 'ASSISTANT', { permissions: ['live.manage'], courseScope: 'SELECTED' })).id, false],
      ['a TEACHER who left the academy', (await staff(w, 'TEACHER', { status: 'LEFT' })).id, false],
      ['a booked student', w.s[0].id, false],
      ['an outsider', w.outsider.id, false],
    ];
    for (const [label, uid, expected] of cases) {
      expect([label, await live.canModerate(uid, w.ls.id)]).toEqual([label, expected]);
    }
  });

  it("a teacher of another academy never moderates this one's class", async () => {
    if (!guard()) return;
    const a = await classroomWorld(prisma);
    const b = await classroomWorld(prisma);
    const { live } = classroom(prisma);
    expect(await live.canModerate(b.teacher.id, a.ls.id)).toBe(false);
  });
});

describe('moderation actions follow it (regression: an assistant used to hold them all)', () => {
  it('an ASSISTANT without live.manage: in the room, but cannot approve, revoke, remove or send', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    // Watching is allowed: the teacher side of the room.
    const st = await rtc.state(w.assistant.id, w.ls.id);
    expect(st.me).toMatchObject({ role: 'TEACHER', moderator: false, canPublish: false });
    expect(st.notJoined).toBeUndefined();
    expect(await codeOf(rtc.hand(w.assistant.id, w.ls.id, 'approve', w.s[0].id))).toBe('NOT_A_MODERATOR');
    expect(await codeOf(rtc.remove(w.assistant.id, w.ls.id, w.s[0].id))).toBe('NOT_A_MODERATOR');
    expect(await codeOf(rtc.openConnection(w.assistant.id, w.ls.id, 'SEND'))).toBe('NOT_A_MODERATOR');
    // The hand is untouched.
    expect((await rtc.state(w.s[0].id, w.ls.id)).me.hand).toBe('HAND_RAISED');
  });

  it('an ASSISTANT granted live.manage runs the class like the teacher', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    const a = await staff(w, 'ASSISTANT', { permissions: ['live.manage'] });
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    expect(await codeOf(rtc.hand(a.id, w.ls.id, 'approve', w.s[0].id))).toBe('ok');
    expect(await codeOf(rtc.hand(a.id, w.ls.id, 'revoke', w.s[0].id))).toBe('ok');
    const { connectionId } = await rtc.openConnection(a.id, w.ls.id, 'SEND');
    expect(await codeOf(rtc.publish(a.id, w.ls.id, connectionId, { offer: OFFER, tracks: [{ mid: '0', kind: 'AUDIO' }] }))).toBe('ok');
    expect(await codeOf(rtc.remove(a.id, w.ls.id, w.s[1].id))).toBe('ok');
    expect((await rtc.state(a.id, w.ls.id)).me.moderator).toBe(true);
  });

  it('a student can neither decide hands nor remove anyone', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    await rtc.hand(w.s[1].id, w.ls.id, 'raise');
    expect(await codeOf(rtc.hand(w.s[0].id, w.ls.id, 'approve', w.s[1].id))).toBe('HAND_DENIED');
    expect(await codeOf(rtc.remove(w.s[0].id, w.ls.id, w.s[1].id))).toBe('HAND_DENIED');
  });

  it('staff cannot remove the teacher side (only students are removed)', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    const t2 = await staff(w, 'TEACHER');
    expect(await codeOf(rtc.remove(t2.id, w.ls.id, w.teacher.id))).toBe('NOT_A_STUDENT');
  });
});

describe('the participant panel foundation', () => {
  it('moderators see who holds a seat and has not joined; students never do', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    await prisma.liveAttendance.create({ data: { sessionId: w.ls.id, userId: w.s[0].id, role: 'STUDENT' } });
    const st = await rtc.state(w.teacher.id, w.ls.id);
    expect(st.notJoined?.map((x) => x.userId).sort()).toEqual([w.s[1].id, w.s[2].id].sort());
    expect((await rtc.state(w.s[0].id, w.ls.id)).notJoined).toBeUndefined();
  });

  it("every participant's own policy is in the state: a listening student may send nothing, may raise a hand", async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const { rtc } = classroom(prisma);
    const me = (await rtc.state(w.s[0].id, w.ls.id)).me;
    expect(me.policy).toMatchObject({ mayOpenSend: false, mayRaiseHand: true, speaker: false });
    expect(me.policy.publish).toMatchObject({ AUDIO: false, VIDEO: false, SCREEN: false });
  });
});
