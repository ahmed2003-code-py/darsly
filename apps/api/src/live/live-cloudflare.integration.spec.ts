import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { LiveEndWorker } from './live-end.worker';
import { LiveScope, LiveService } from './live.service';
import { CloudflareLiveProvider } from './providers/cloudflare-live.provider';
import { CF_STUN, CloudflareRealtimeError } from './providers/cloudflare-realtime.client';
import { DailyLiveProvider } from './providers/daily-live.provider';
import { LiveProviders } from './providers/live-providers';
import { LiveRtcService } from './rtc/live-rtc.service';

/**
 * Checkpoint B.6 on a real PostgreSQL: the Cloudflare classroom's server side.
 *
 * The SFU is a fake that behaves like the HTTPS API (sessions, tracks by mid
 * and name, force-close) and records every call; everything Darsly decides —
 * who may send, who may pull what, raise hand, reconnects, the end and its
 * teardown — runs for real against the database, with its locks.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveRtcConnection', 'liveHand']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.LIVE_MAX_SPEAKERS;
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

/** An in-memory SFU with the HTTPS API's shape. */
function fakeSfu() {
  let n = 0;
  const sessions = new Map<
    string,
    Map<string, { mid: string; trackName: string; location: string; status: string }>
  >();
  const failClose = { remaining: 0 };
  const client = {
    configured: true,
    turnConfigured: false,
    iceServers: jest.fn(async () => [CF_STUN]),
    newSession: jest.fn(async () => {
      const id = randomUUID().replace(/-/g, '') + (++n).toString(16);
      sessions.set(id, new Map());
      return id;
    }),
    pushTracks: jest.fn(
      async (sid: string, _offer: unknown, tracks: { mid: string; trackName: string }[]) => {
        const s = sessions.get(sid)!;
        for (const t of tracks) s.set(t.mid, { ...t, location: 'local', status: 'active' });
        return {
          sessionDescription: { type: 'answer', sdp: 'v=0 answer' },
          tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.trackName })),
        };
      },
    ),
    pullTracks: jest.fn(async (sid: string, tracks: { sessionId: string; trackName: string }[]) => {
      const me = sessions.get(sid)!;
      const out = tracks.map((t) => {
        const src = [...(sessions.get(t.sessionId)?.values() ?? [])].find(
          (x) => x.trackName === t.trackName && x.status === 'active',
        );
        if (!src) return { ...t, errorCode: 'not_found' };
        const mid = String(me.size + 100);
        me.set(mid, { mid, trackName: t.trackName, location: 'remote', status: 'active' });
        return { ...t, mid };
      });
      return {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'v=0 offer' },
        tracks: out,
      };
    }),
    renegotiate: jest.fn(async () => ({})),
    selectLayer: jest.fn(async () => ({ requiresImmediateRenegotiation: false })),
    closeTracks: jest.fn(async (sid: string, mids: string[]) => {
      if (failClose.remaining > 0) {
        failClose.remaining--;
        throw new CloudflareRealtimeError('server', 503, 'PUT /sessions/<id>/tracks/close → 503');
      }
      const s = sessions.get(sid);
      for (const m of mids) {
        const t = s?.get(m);
        if (t) t.status = 'inactive';
      }
      return {};
    }),
    getSession: jest.fn(async (sid: string) => ({
      tracks: [...(sessions.get(sid)?.values() ?? [])],
    })),
  };
  /** Whether the publisher's track is still live at the SFU (what subscribers receive from). */
  const active = (trackName: string) =>
    [...sessions.values()].some((s) =>
      [...s.values()].some(
        (t) => t.trackName === trackName && t.location === 'local' && t.status === 'active',
      ),
    );
  return { client, sessions, failClose, active };
}

function build() {
  const sfu = fakeSfu();
  const realtime = { emitToLive: jest.fn(), emitToUser: jest.fn() };
  const cloudflare = new CloudflareLiveProvider(prisma, sfu.client as any);
  const daily = new DailyLiveProvider({
    configured: true,
    closeRoom: jest.fn(async () => 'deleted'),
    meetingToken: jest.fn(async () => 'tok'),
  } as any);
  const providers = new LiveProviders([daily, cloudflare], 'CLOUDFLARE');
  const svc = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    { recordOrThrow: jest.fn(async () => ({})) } as any,
    providers,
    realtime as any,
    {} as any,
    {
      assertAssignableTeacher: jest.fn(),
    } as any,
  );
  const rtc = new LiveRtcService(prisma, svc, cloudflare, realtime as any);
  return { sfu, realtime, cloudflare, providers, svc, rtc };
}

/** A running Cloudflare class, a teacher, three booked students and one who did not book. */
async function world(session: Record<string, unknown> = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `cft-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `cft-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `cfa-${k}`, name: `A ${k}`, ownerUserId: teacher.id },
  });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() - 10 * MIN),
      startedAt: new Date(Date.now() - 11 * MIN),
      durationMin: 60,
      status: 'LIVE',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}-run1`,
      roomUrl: null,
      ...session,
    },
  });
  const students = [];
  for (let i = 0; i < 4; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `S${i} ${k}`, email: `cfs${i}-${k}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    if (i < 3) await prisma.liveBooking.create({ data: { sessionId: ls.id, studentId: sp.id } });
    students.push(u);
  }
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { k, teacher, tp, ls, s: students.slice(0, 3), outsider: students[3], scope };
}
type World = Awaited<ReturnType<typeof world>>;

const OFFER = { type: 'offer' as const, sdp: 'v=0 offer' };

/** The teacher in the room, sending camera, microphone and a screen. */
async function teacherLive(rtc: LiveRtcService, w: World) {
  const { connectionId } = await rtc.openConnection(w.teacher.id, w.ls.id, 'SEND');
  await rtc.publish(w.teacher.id, w.ls.id, connectionId, {
    offer: OFFER,
    tracks: [
      { mid: '0', kind: 'AUDIO' },
      { mid: '1', kind: 'VIDEO' },
      { mid: '2', kind: 'SCREEN' },
    ],
  });
  return connectionId;
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e?.response?.code ?? e?.message,
  );

describe('B.6 Cloudflare classroom on Postgres: the gate', () => {
  it('lets in the teacher and booked students only, while the class is live', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc } = build();
    await expect(rtc.gate(w.teacher.id, w.ls.id)).resolves.toMatchObject({ role: 'TEACHER' });
    await expect(rtc.gate(w.s[0].id, w.ls.id)).resolves.toMatchObject({ role: 'STUDENT' });
    // Did not book: the same answer the chat and the join give.
    expect(await code(rtc.gate(w.outsider.id, w.ls.id))).toBe('You are not in this session');
  });

  it('refuses before the start, after the end, on a Daily class, and once ENDED', async () => {
    if (!guard()) return;
    const { rtc } = build();
    const scheduled = await world({ status: 'SCHEDULED', roomName: null, startedAt: null });
    expect(await code(rtc.gate(scheduled.teacher.id, scheduled.ls.id))).toBe('NOT_STARTED');
    const over = await world({ startsAt: new Date(Date.now() - 61 * MIN) });
    expect(await code(rtc.gate(over.s[0].id, over.ls.id))).toBe('ENDED');
    const ended = await world({ status: 'ENDED', endedAt: new Date() });
    expect(await code(rtc.gate(ended.s[0].id, ended.ls.id))).toBe('ENDED');
    const daily = await world({ provider: 'DAILY', roomName: `darsly-x-${randomUUID()}` });
    expect(await code(rtc.gate(daily.s[0].id, daily.ls.id))).toBe('LIVE_WRONG_PROVIDER');
  });
});

describe('B.6 Cloudflare classroom on Postgres: sending and receiving', () => {
  it('education mode: a student receives, and cannot send without the teacher', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc } = build();
    await teacherLive(rtc, w);
    await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    expect(await code(rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe('NOT_ALLOWED_TO_SPEAK');
    const st = await rtc.state(w.s[0].id, w.ls.id);
    expect(st.me).toMatchObject({ role: 'STUDENT', hand: 'IDLE', canPublish: false });
    expect(st.tracks.map((t) => t.kind).sort()).toEqual(['AUDIO', 'SCREEN', 'VIDEO']);
    expect(st.tracks.every((t) => t.role === 'TEACHER')).toBe(true);
  });

  it('pulls by Darsly track id, from the SFU session the server looks up', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, sfu } = build();
    await teacherLive(rtc, w);
    const teacherCf = (
      await prisma.liveRtcConnection.findFirstOrThrow({
        where: { sessionId: w.ls.id, userId: w.teacher.id },
      })
    ).cfSessionId;
    const { connectionId } = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const st = await rtc.state(w.s[0].id, w.ls.id);
    const r = await rtc.subscribe(w.s[0].id, w.ls.id, connectionId, {
      trackIds: st.tracks.map((t) => t.id),
    });
    expect(r.requiresImmediateRenegotiation).toBe(true);
    expect(r.tracks.every((t) => t.mid && !t.error)).toBe(true);
    const pulled = sfu.client.pullTracks.mock.calls[0][1] as { sessionId: string }[];
    expect(pulled.every((p) => p.sessionId === teacherCf)).toBe(true);
    // The browser never sees an SFU session id.
    expect(JSON.stringify(st)).not.toContain(teacherCf);
    expect(JSON.stringify(r)).not.toContain(teacherCf);
    await rtc.renegotiate(w.s[0].id, w.ls.id, connectionId, { type: 'answer', sdp: 'v=0' });
    expect(sfu.client.renegotiate).toHaveBeenCalledTimes(1);
  });

  it('refuses a track that is closed, one that is not in the class, and a connection that is not yours', async () => {
    if (!guard()) return;
    const w = await world();
    const other = await world();
    const { rtc } = build();
    const tconn = await teacherLive(rtc, w);
    const otherTeacher = await teacherLive(rtc, other);
    void otherTeacher;
    const mine = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const theirs = await rtc.openConnection(w.s[1].id, w.ls.id, 'RECEIVE');
    const st = await rtc.state(w.s[0].id, w.ls.id);
    const foreign = (await rtc.state(other.s[0].id, other.ls.id)).tracks[0].id;
    expect(
      await code(rtc.subscribe(w.s[0].id, w.ls.id, mine.connectionId, { trackIds: [foreign] })),
    ).toBe('RTC_TRACKS_GONE');
    expect(
      await code(
        rtc.subscribe(w.s[0].id, w.ls.id, theirs.connectionId, { trackIds: [st.tracks[0].id] }),
      ),
    ).toBe('RTC_CONNECTION_GONE');
    // The teacher stops the screen share: that track can no longer be pulled.
    await rtc.closeTracks(w.teacher.id, w.ls.id, tconn, { mids: ['2'] });
    const screen = st.tracks.find((t) => t.kind === 'SCREEN')!.id;
    expect(
      await code(rtc.subscribe(w.s[0].id, w.ls.id, mine.connectionId, { trackIds: [screen] })),
    ).toBe('RTC_TRACKS_GONE');
    // Receiving on a sending connection is not a thing.
    expect(
      await code(rtc.subscribe(w.teacher.id, w.ls.id, tconn, { trackIds: [st.tracks[0].id] })),
    ).toBe('RTC_CONNECTION_GONE');
  });

  it('lets each side send only what it may, once per kind', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc } = build();
    const { connectionId } = await rtc.openConnection(w.teacher.id, w.ls.id, 'SEND');
    expect(
      await code(
        rtc.publish(w.teacher.id, w.ls.id, connectionId, {
          offer: OFFER,
          tracks: [
            { mid: '0', kind: 'VIDEO' },
            { mid: '1', kind: 'VIDEO' },
          ],
        }),
      ),
    ).toBe('RTC_TRACK_DENIED');
    // An approved student may send a voice and a face — never a screen.
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const send = await rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    expect(
      await code(
        rtc.publish(w.s[0].id, w.ls.id, send.connectionId, {
          offer: OFFER,
          tracks: [{ mid: '0', kind: 'SCREEN' }],
        }),
      ),
    ).toBe('RTC_TRACK_DENIED');
    // A restarted camera replaces the last one rather than adding a tile.
    await rtc.publish(w.teacher.id, w.ls.id, connectionId, {
      offer: OFFER,
      tracks: [{ mid: '0', kind: 'VIDEO' }],
    });
    await rtc.publish(w.teacher.id, w.ls.id, connectionId, {
      offer: OFFER,
      tracks: [{ mid: '3', kind: 'VIDEO' }],
    });
    const st = await rtc.state(w.teacher.id, w.ls.id);
    expect(st.tracks.filter((t) => t.userId === w.teacher.id && t.kind === 'VIDEO')).toHaveLength(
      1,
    );
  });
});

describe('B.6 Cloudflare classroom on Postgres: simulcast layers', () => {
  it("a student picks the layer of the teacher's camera they receive — and nothing else", async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, sfu } = build();
    await teacherLive(rtc, w);
    const { connectionId } = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const st = await rtc.state(w.s[0].id, w.ls.id);
    const cam = st.tracks.find((t) => t.kind === 'VIDEO')!;
    const voice = st.tracks.find((t) => t.kind === 'AUDIO')!;
    await rtc.subscribe(w.s[0].id, w.ls.id, connectionId, {
      trackIds: st.tracks.map((t) => t.id),
      preferredRid: 'h',
    });
    // Only the teacher's camera was asked for in a layer.
    const asked = sfu.client.pullTracks.mock.calls[0][1] as { preferredRid?: string }[];
    expect(asked.filter((x) => x.preferredRid === 'h')).toHaveLength(1);

    await expect(
      rtc.selectLayer(w.s[0].id, w.ls.id, connectionId, { trackId: cam.id, mid: '100', rid: 'l' }),
    ).resolves.toEqual({ rid: 'l' });
    const teacherCf = (
      await prisma.liveRtcConnection.findFirstOrThrow({
        where: { sessionId: w.ls.id, userId: w.teacher.id },
      })
    ).cfSessionId;
    expect(sfu.client.selectLayer).toHaveBeenCalledWith(expect.any(String), {
      sessionId: teacherCf,
      trackName: expect.stringMatching(/^video-/),
      mid: '100',
      preferredRid: 'l',
    });
    // Not a video, not in this class, not your connection: refused.
    expect(
      await code(
        rtc.selectLayer(w.s[0].id, w.ls.id, connectionId, {
          trackId: voice.id,
          mid: '1',
          rid: 'l',
        }),
      ),
    ).toBe('RTC_TRACKS_GONE');
    const other = await rtc.openConnection(w.s[1].id, w.ls.id, 'RECEIVE');
    expect(
      await code(
        rtc.selectLayer(w.s[0].id, w.ls.id, other.connectionId, {
          trackId: cam.id,
          mid: '1',
          rid: 'l',
        }),
      ),
    ).toBe('RTC_CONNECTION_GONE');
  });
});

describe('B.6 Cloudflare classroom on Postgres: raise hand', () => {
  it('raise → approve → speak → revoke, and the revoke holds at the SFU', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, sfu, realtime } = build();
    await teacherLive(rtc, w);
    const listener = await rtc.openConnection(w.s[1].id, w.ls.id, 'RECEIVE');

    expect(await rtc.hand(w.s[0].id, w.ls.id, 'raise')).toEqual({ state: 'HAND_RAISED' });
    // A student cannot approve themselves, or anyone.
    expect(await code(rtc.hand(w.s[0].id, w.ls.id, 'approve', w.s[0].id))).toBe('HAND_DENIED');
    expect(await rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id)).toEqual({
      state: 'APPROVED_TO_SPEAK',
    });
    expect(realtime.emitToUser).toHaveBeenCalledWith(w.s[0].id, 'live:hand', {
      sessionId: w.ls.id,
      state: 'APPROVED_TO_SPEAK',
    });

    const send = await rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    await rtc.publish(w.s[0].id, w.ls.id, send.connectionId, {
      offer: OFFER,
      tracks: [{ mid: '0', kind: 'AUDIO' }],
    });
    let st = await rtc.state(w.s[1].id, w.ls.id);
    expect(st.participants.find((p) => p.userId === w.s[0].id)).toMatchObject({
      hand: 'ACTIVE_SPEAKER',
      audio: true,
    });
    const voice = st.tracks.find((t) => t.userId === w.s[0].id)!;
    await rtc.subscribe(w.s[1].id, w.ls.id, listener.connectionId, { trackIds: [voice.id] });
    const voiceName = (await prisma.liveRtcTrack.findUniqueOrThrow({ where: { id: voice.id } }))
      .trackName;
    expect(sfu.active(voiceName)).toBe(true);

    // Revoked: the microphone is closed at the SFU, whatever the browser does.
    expect(await rtc.hand(w.teacher.id, w.ls.id, 'revoke', w.s[0].id)).toEqual({
      state: 'RELEASED',
    });
    expect(sfu.active(voiceName)).toBe(false);
    expect(sfu.client.closeTracks).toHaveBeenCalledWith(expect.any(String), ['0'], { force: true });
    st = await rtc.state(w.s[1].id, w.ls.id);
    expect(st.tracks.some((t) => t.userId === w.s[0].id)).toBe(false);
    // …and nothing it held still works: not the old connection, not a new one.
    expect(
      await code(
        rtc.publish(w.s[0].id, w.ls.id, send.connectionId, {
          offer: OFFER,
          tracks: [{ mid: '1', kind: 'AUDIO' }],
        }),
      ),
    ).toBe('RTC_CONNECTION_GONE');
    expect(await code(rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe('NOT_ALLOWED_TO_SPEAK');
    expect(
      await code(
        rtc.subscribe(w.s[1].id, w.ls.id, listener.connectionId, { trackIds: [voice.id] }),
      ),
    ).toBe('RTC_TRACKS_GONE');
    // A released student may ask again.
    expect(await rtc.hand(w.s[0].id, w.ls.id, 'raise')).toEqual({ state: 'HAND_RAISED' });
  });

  it('a push racing a revoke is refused even before the revoke has torn anything down', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc } = build();
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const send = await rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    // The revoke's state change has landed; its SFU teardown has not run yet.
    await prisma.liveHand.update({
      where: { sessionId_userId: { sessionId: w.ls.id, userId: w.s[0].id } },
      data: { state: 'RELEASED' },
    });
    expect(
      await code(
        rtc.publish(w.s[0].id, w.ls.id, send.connectionId, {
          offer: OFFER,
          tracks: [{ mid: '0', kind: 'AUDIO' }],
        }),
      ),
    ).toBe('NOT_ALLOWED_TO_SPEAK');
    expect(await prisma.liveRtcTrack.count({ where: { connectionId: send.connectionId } })).toBe(0);
  });

  it('refuses steps that do not follow the drawn edges', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc } = build();
    expect(await code(rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id))).toBe('HAND_STATE');
    expect(await code(rtc.hand(w.teacher.id, w.ls.id, 'revoke', w.s[0].id))).toBe('HAND_STATE');
    expect(await code(rtc.hand(w.teacher.id, w.ls.id, 'raise'))).toBe('HAND_DENIED');
    // Not a student of this class.
    expect(await code(rtc.hand(w.teacher.id, w.ls.id, 'approve', w.outsider.id))).toBe(
      'Student not in this class',
    );
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    expect(await code(rtc.hand(w.s[0].id, w.ls.id, 'raise'))).toBe('HAND_STATE');
    expect(await rtc.hand(w.teacher.id, w.ls.id, 'reject', w.s[0].id)).toEqual({ state: 'IDLE' });
  });

  it('never approves more speakers than allowed, even when approvals race', async () => {
    if (!guard()) return;
    process.env.LIVE_MAX_SPEAKERS = '2';
    const w = await world();
    // A fourth and fifth booked student, so four hands can go up.
    const extra = [];
    for (let i = 0; i < 2; i++) {
      const u = await prisma.user.create({
        data: { role: 'STUDENT', fullName: `X${i}`, email: `cfx${i}-${w.k}@it.test` },
      });
      const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
      await prisma.liveBooking.create({ data: { sessionId: w.ls.id, studentId: sp.id } });
      extra.push(u);
    }
    const four = [w.s[0], w.s[1], w.s[2], extra[0]];
    const { rtc } = build();
    for (const u of four) await rtc.hand(u.id, w.ls.id, 'raise');
    const results = await Promise.all(
      four.map((u) => code(rtc.hand(w.teacher.id, w.ls.id, 'approve', u.id))),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'SPEAKER_LIMIT')).toHaveLength(2);
    expect(
      await prisma.liveHand.count({
        where: { sessionId: w.ls.id, state: { in: ['APPROVED_TO_SPEAK', 'ACTIVE_SPEAKER'] } },
      }),
    ).toBe(2);
  });
});

describe('B.6 Cloudflare classroom on Postgres: reconnects', () => {
  it('a reconnect replaces the old connection, and an approved speaker keeps the permission — not the old tracks', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, sfu } = build();
    await teacherLive(rtc, w);
    const r1 = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const r2 = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const old = await prisma.liveRtcConnection.findUniqueOrThrow({
      where: { id: r1.connectionId },
    });
    expect(old.closeReason).toBe('replaced');
    expect(old.closedAt).not.toBeNull();
    void r2;

    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    const s1 = await rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    await rtc.publish(w.s[0].id, w.ls.id, s1.connectionId, {
      offer: OFFER,
      tracks: [{ mid: '0', kind: 'AUDIO' }],
    });
    const first = await prisma.liveRtcTrack.findFirstOrThrow({
      where: { connectionId: s1.connectionId },
    });
    // The phone drops and comes back: a new sending connection.
    const s2 = await rtc.openConnection(w.s[0].id, w.ls.id, 'SEND');
    expect(sfu.active(first.trackName)).toBe(false);
    await rtc.publish(w.s[0].id, w.ls.id, s2.connectionId, {
      offer: OFFER,
      tracks: [{ mid: '0', kind: 'AUDIO' }],
    });
    const st = await rtc.state(w.teacher.id, w.ls.id);
    expect(st.tracks.filter((t) => t.userId === w.s[0].id)).toHaveLength(1);
    expect(st.participants.find((p) => p.userId === w.s[0].id)?.hand).toBe('ACTIVE_SPEAKER');
  });

  it('a reopened class is a new run: last run’s hands grant nothing, its connections are swept', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, svc } = build();
    await teacherLive(rtc, w);
    await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    await rtc.hand(w.s[0].id, w.ls.id, 'raise');
    await rtc.hand(w.teacher.id, w.ls.id, 'approve', w.s[0].id);
    // The class is reopened as a new run (what start() does after an end).
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { roomName: `cf-${w.k}-run2` },
    });
    expect(await code(rtc.openConnection(w.s[0].id, w.ls.id, 'SEND'))).toBe('NOT_ALLOWED_TO_SPEAK');
    expect((await rtc.state(w.s[0].id, w.ls.id)).me.hand).toBe('IDLE');
    await svc.sweepProviderCleanups(100);
    expect(
      await prisma.liveRtcConnection.count({
        where: { sessionId: w.ls.id, roomName: `cf-${w.k}-run1`, closedAt: null },
      }),
    ).toBe(0);
  });
});

describe('B.6 Cloudflare classroom on Postgres: the end', () => {
  it('ending closes the class first, then tears the media down at the SFU', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, svc, sfu, realtime } = build();
    await teacherLive(rtc, w);
    const recv = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const names = (await prisma.liveRtcTrack.findMany({ where: { sessionId: w.ls.id } })).map(
      (t) => t.trackName,
    );
    const r = await svc.endSession(w.ls.id, 'MANUAL');
    expect(r.outcome).toBe('ended');
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.status).toBe('ENDED');
    expect(realtime.emitToLive).toHaveBeenCalledWith(w.ls.id, 'live:ended', { sessionId: w.ls.id });
    // Nobody can push or pull from the moment it is ENDED.
    expect(
      await code(rtc.subscribe(w.s[0].id, w.ls.id, recv.connectionId, { trackIds: ['x'] })),
    ).toBe('ENDED');
    expect(await code(rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE'))).toBe('ENDED');
    // The teardown runs after the commit.
    await svc.cleanupRoom({ id: w.ls.id, provider: 'CLOUDFLARE' }, row.roomName!);
    expect(names.every((n) => !sfu.active(n))).toBe(true);
    expect(
      await prisma.liveRtcConnection.count({ where: { sessionId: w.ls.id, closedAt: null } }),
    ).toBe(0);
    // What the run used is kept on the class, once.
    const usage = (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } }))
      .usage as Record<string, any>;
    expect(usage[row.roomName!]).toMatchObject({
      provider: 'CLOUDFLARE',
      connections: 2,
      peakReceivers: 1,
    });
    // Ending again changes nothing (idempotent), and never reopens.
    expect((await svc.endSession(w.ls.id, 'MANUAL')).outcome).toBe('already-ended');
  });

  it('a teardown the SFU refuses does not keep the class LIVE; the sweep finishes it', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, svc, sfu } = build();
    await teacherLive(rtc, w);
    sfu.failClose.remaining = 4; // the provider has a bad minute
    const r = await svc.endSession(w.ls.id, 'MANUAL');
    expect(r.outcome).toBe('ended');
    await new Promise((res) => setTimeout(res, 300)); // the post-commit attempt
    expect((await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).status).toBe(
      'ENDED',
    );
    let open = await prisma.liveRtcConnection.count({
      where: { sessionId: w.ls.id, closedAt: null },
    });
    expect(open).toBe(1);
    // Two sweeps later the SFU answers again and the teardown completes.
    for (let i = 0; i < 4 && open; i++) {
      await svc.sweepProviderCleanups(100);
      open = await prisma.liveRtcConnection.count({
        where: { sessionId: w.ls.id, closedAt: null },
      });
    }
    expect(open).toBe(0);
    const c = await prisma.liveRtcConnection.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(c.closeReason).toBe('class-ended');
  });

  it('the end sweep ends a Cloudflare class at its scheduled end', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN) });
    const { svc } = build();
    const worker = new LiveEndWorker(svc);
    // The sweep is global and oldest-first, a batch at a time: on a shared
    // test database other overdue classes may be ahead of this one, so it runs
    // until this class's turn comes (as it would on consecutive ticks).
    let row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    for (let i = 0; i < 40 && row.status !== 'ENDED'; i++) {
      await worker.sweep();
      row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    }
    expect(row.status).toBe('ENDED');
    expect(row.endedAt!.getTime()).toBe(w.ls.startsAt.getTime() + 60 * MIN);
  });
});

describe('B.6 Cloudflare classroom on Postgres: start, entry, removal', () => {
  it('a new class takes the configured provider; starting it calls no provider; entry hands out no secret', async () => {
    if (!guard()) return;
    const w = await world({ status: 'SCHEDULED', roomName: null, startedAt: null });
    const { svc, sfu } = build();
    const res = await svc.start(w.scope, w.ls.id, w.teacher.id);
    expect(res.meeting).toEqual({
      provider: 'cloudflare',
      iceServers: [CF_STUN],
      rtcPath: `/live/${w.ls.id}/rtc`,
    });
    expect(sfu.client.newSession).not.toHaveBeenCalled();
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.roomName).toMatch(new RegExp(`^cf-${w.ls.id}-`));
    expect(row.roomUrl).toBeNull();
    // A student comes in the same way.
    const j = await svc.join(w.s[0].id, w.ls.id);
    expect(j.meeting).toMatchObject({ provider: 'cloudflare' });
    expect(JSON.stringify(j)).not.toMatch(/secret|Bearer/i);
  });

  it('the teacher removes a student: what they send and receive is closed, and they are told', async () => {
    if (!guard()) return;
    const w = await world();
    const { rtc, sfu, realtime } = build();
    await teacherLive(rtc, w);
    const recv = await rtc.openConnection(w.s[0].id, w.ls.id, 'RECEIVE');
    const st = await rtc.state(w.s[0].id, w.ls.id);
    await rtc.subscribe(w.s[0].id, w.ls.id, recv.connectionId, {
      trackIds: st.tracks.map((t) => t.id),
    });
    expect(await code(rtc.remove(w.s[1].id, w.ls.id, w.s[0].id))).toBe('HAND_DENIED');
    await rtc.remove(w.teacher.id, w.ls.id, w.s[0].id);
    expect(sfu.client.getSession).toHaveBeenCalled();
    expect(realtime.emitToUser).toHaveBeenCalledWith(w.s[0].id, 'live:removed', {
      sessionId: w.ls.id,
    });
    expect(
      await prisma.liveRtcConnection.count({
        where: { sessionId: w.ls.id, userId: w.s[0].id, closedAt: null },
      }),
    ).toBe(0);
  });
});
