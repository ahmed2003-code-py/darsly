import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import {
  classroom,
  classroomWorld,
  codeOf,
  confirmedGuest,
  enterRoom,
  OFFER,
  type ClassroomWorld,
} from './testing/classroom';

/**
 * Live V1 Phase C on a real PostgreSQL: who may speak. RAISE_HAND (the
 * default) and LISTEN_ONLY, the teacher's invitation (a permission, never a
 * switch), a moderator's per-run microphone block — all decided on the
 * server, and held at the SFU whatever a browser does.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveHand', 'liveParticipantControl']);
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
/** The student sends their microphone on a fresh SEND connection. */
async function speak(c: C, w: ClassroomWorld, userId: string) {
  const { connectionId } = await c.rtc.openConnection(userId, w.ls.id, 'SEND');
  await c.rtc.publish(userId, w.ls.id, connectionId, {
    offer: OFFER,
    tracks: [{ mid: '0', kind: 'AUDIO' }],
  });
  const t = await prisma.liveRtcTrack.findFirstOrThrow({
    where: { connectionId, kind: 'AUDIO' },
    select: { trackName: true },
  });
  return { connectionId, trackName: t.trackName };
}

describe('RAISE_HAND (the default)', () => {
  it('a student sends nothing until approved — the server refuses, not the page', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    expect(await codeOf(c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
    await c.rtc.hand(w.s[0].id, w.ls.id, 'raise');
    expect(await codeOf(c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
    await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const { trackName } = await speak(c, w, w.s[0].id);
    expect(c.sfu.active(trackName)).toBe(true);
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.hand).toBe('ACTIVE_SPEAKER');
  });
});

describe('LISTEN_ONLY', () => {
  it('raising is refused by the server; switching lowers raised hands and leaves speakers alone', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    for (const s of w.s) await enterRoom(prisma, c, w, s.id);
    await c.rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await c.rtc.hand(w.s[1].id, w.ls.id, 'raise');
    await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[1].id);
    const { trackName } = await speak(c, w, w.s[1].id);
    await c.rtc.setMicPolicy(w.ls.id, 'LISTEN_ONLY', w.teacher.id);
    const st = await c.rtc.state(w.teacher.id, w.ls.id);
    expect(st.policies.mic).toBe('LISTEN_ONLY');
    expect(st.participants.find((p) => p.userId === w.s[0].id)?.hand).toBe('IDLE');
    expect(st.participants.find((p) => p.userId === w.s[1].id)?.hand).toBe('ACTIVE_SPEAKER');
    expect(c.sfu.active(trackName)).toBe(true);
    expect(await codeOf(c.rtc.hand(w.s[2].id, w.ls.id, 'raise'))).toBe('HAND_DISABLED');
    expect((await c.rtc.state(w.s[2].id, w.ls.id)).me.policy.mayRaiseHand).toBe(false);
  });

  it('the teacher invites: a permission sent to the student, nothing switched on until they publish', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await c.rtc.setMicPolicy(w.ls.id, 'LISTEN_ONLY', w.teacher.id);
    expect(await c.rtc.hand(w.teacher.id, w.ls.id, 'invite', w.s[0].id)).toEqual({
      state: 'APPROVED_TO_SPEAK',
    });
    expect(c.events).toContainEqual({
      to: 'user',
      id: w.s[0].id,
      event: 'live:hand',
      payload: { sessionId: w.ls.id, state: 'APPROVED_TO_SPEAK', invited: true },
    });
    // No track exists until the student's own publish.
    expect(
      await prisma.liveRtcTrack.count({ where: { sessionId: w.ls.id, userId: w.s[0].id } }),
    ).toBe(0);
    await speak(c, w, w.s[0].id);
    expect(
      await prisma.liveRtcTrack.count({
        where: { sessionId: w.ls.id, userId: w.s[0].id, kind: 'AUDIO' },
      }),
    ).toBe(1);
  });

  it('"later": the student declines an invitation; nothing was ever sent', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await c.rtc.hand(w.teacher.id, w.ls.id, 'invite', w.s[0].id);
    expect(await c.rtc.hand(w.s[0].id, w.ls.id, 'lower')).toEqual({ state: 'RELEASED' });
    expect(await codeOf(c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
  });

  it('only a moderator invites', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    expect(await codeOf(c.rtc.hand(w.assistant.id, w.ls.id, 'invite', w.s[0].id))).toBe(
      'NOT_A_MODERATOR',
    );
    expect(await codeOf(c.rtc.hand(w.s[1].id, w.ls.id, 'invite', w.s[0].id))).toBe('HAND_DENIED');
  });

  it('race: a policy switch and a raise never leave a raised hand under LISTEN_ONLY', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    for (let i = 0; i < 8; i++) {
      await c.rtc.setMicPolicy(w.ls.id, 'RAISE_HAND', w.teacher.id);
      await prisma.liveHand.deleteMany({ where: { sessionId: w.ls.id } });
      await Promise.allSettled([
        c.rtc.hand(w.s[0].id, w.ls.id, 'raise'),
        c.rtc.setMicPolicy(w.ls.id, 'LISTEN_ONLY', w.teacher.id),
        c.rtc.hand(w.s[1].id, w.ls.id, 'raise'),
      ]);
      const raised = await prisma.liveHand.count({
        where: { sessionId: w.ls.id, state: 'HAND_RAISED' },
      });
      expect(raised).toBe(0);
    }
  });
});

describe('a moderator blocks one microphone (this run only)', () => {
  it('blocking a speaker releases the floor and closes their microphone at the SFU', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await enterRoom(prisma, c, w, w.s[0].id);
    await c.rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const { trackName } = await speak(c, w, w.s[0].id);
    expect(
      await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { mic: 'BLOCKED' }),
    ).toMatchObject({ mic: 'BLOCKED' });
    expect(c.sfu.active(trackName)).toBe(false);
    const me = (await c.rtc.state(w.s[0].id, w.ls.id)).me;
    expect(me).toMatchObject({ hand: 'RELEASED', canPublish: false });
    expect(me.policy).toMatchObject({ micBlocked: true, mayRaiseHand: false });
    // Refresh / reconnect in the same run: still blocked, everywhere.
    expect(await codeOf(c.rtc.hand(w.s[0].id, w.ls.id, 'raise'))).toBe('MIC_BLOCKED');
    expect(await codeOf(c.rtc.hand(w.teacher.id, w.ls.id, 'invite', w.s[0].id))).toBe(
      'MIC_BLOCKED',
    );
    expect(await codeOf(c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
    // The moderator sees it on the row.
    const row = (await c.rtc.state(w.teacher.id, w.ls.id)).participants.find(
      (p) => p.userId === w.s[0].id,
    );
    expect(row?.controls).toMatchObject({ mic: 'BLOCKED', camera: 'DEFAULT' });
    // Unblocked: allowed to ask again — nothing restored by itself.
    await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { mic: 'DEFAULT' });
    expect((await c.rtc.state(w.s[0].id, w.ls.id)).me.hand).toBe('RELEASED');
    expect(await c.rtc.hand(w.s[0].id, w.ls.id, 'raise')).toEqual({ state: 'HAND_RAISED' });
  });

  it('a new run of the class starts from the defaults', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { mic: 'BLOCKED' });
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { roomName: `cf-${w.k}-run2` },
    });
    const me = (await c.rtc.state(w.s[0].id, w.ls.id)).me;
    expect(me.policy.micBlocked).toBe(false);
    expect(await c.rtc.hand(w.s[0].id, w.ls.id, 'raise')).toEqual({ state: 'HAND_RAISED' });
    // A write in the new run does not revive the old block either.
    await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[1].id, {});
    expect(
      (await c.rtc.state(w.teacher.id, w.ls.id)).participants.find((p) => p.userId === w.s[0].id)
        ?.controls ?? { mic: 'DEFAULT' },
    ).toMatchObject({ mic: 'DEFAULT' });
  });

  it('only a moderator sets controls; only students have them; guests can be blocked too', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma, { accessMode: 'FREE' });
    const c = classroom(prisma);
    expect(
      await codeOf(c.rtc.setControls(w.assistant.id, w.ls.id, w.s[0].id, { mic: 'BLOCKED' })),
    ).toBe('NOT_A_MODERATOR');
    expect(await codeOf(c.rtc.setControls(w.s[1].id, w.ls.id, w.s[0].id, { mic: 'BLOCKED' }))).toBe(
      'NOT_ALLOWED_TO_SPEAK',
    );
    expect(
      await codeOf(c.rtc.setControls(w.teacher.id, w.ls.id, w.outsider.id, { mic: 'BLOCKED' })),
    ).toBe('NOT_A_STUDENT');
    const g = await confirmedGuest(prisma, w, 'ضيف');
    expect(await c.rtc.setControls(w.teacher.id, w.ls.id, g.id, { mic: 'BLOCKED' })).toMatchObject({
      mic: 'BLOCKED',
    });
  });

  it('race: a block that lands while the student is publishing still holds at the SFU', async () => {
    if (!guard()) return;
    const w = await classroomWorld(prisma);
    const c = classroom(prisma);
    await c.rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await c.rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const { connectionId } = await c.rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    // The block arrives while the SFU is answering the push.
    const push = c.sfu.client.pushTracks;
    c.sfu.client.pushTracks = async (...a: Parameters<typeof push>) => {
      await c.rtc.setControls(w.teacher.id, w.ls.id, w.s[0].id, { mic: 'BLOCKED' });
      return push(...a);
    };
    expect(
      await codeOf(
        c.rtc.publish(w.s[0].id, w.ls.id, connectionId, {
          offer: OFFER,
          tracks: [{ mid: '0', kind: 'AUDIO' }],
        }),
      ),
    ).toBe('NOT_ALLOWED_TO_SPEAK');
    const open = await prisma.liveRtcTrack.findMany({
      where: {
        sessionId: w.ls.id,
        userId: w.s[0].id,
        closedAt: null,
        connection: { closedAt: null },
      },
    });
    expect(open).toHaveLength(0);
  });
});
