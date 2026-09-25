import { randomUUID } from 'crypto';
import { databaseReady } from '../common/testing/db-available';
import { AchievementsService } from '../gamification/achievements.service';
import { GamificationConfigService } from '../gamification/gamification.config.service';
import { GamificationService } from '../gamification/gamification.service';
import { LeaderboardService } from '../gamification/leaderboard.service';
import { MissionsService } from '../gamification/missions.service';
import { PrismaService } from '../prisma/prisma.service';
import { DailyService } from './daily.service';
import { LiveEndWorker } from './live-end.worker';
import { LiveScope, LiveService } from './live.service';
import { dailyProviders } from './providers/testing';

/**
 * Checkpoint B against a real PostgreSQL: the parts a mock cannot prove.
 *
 *  - two extensions of one class serialise on the row lock, and the provider
 *    and the database end on the same expiry;
 *  - the heartbeat is one UPDATE whose credit Postgres re-evaluates after a
 *    lock wait, so duplicates, two tabs and concurrent requests cannot
 *    double-count;
 *  - the reward is paid exactly once when several heartbeats cross the
 *    threshold together, and a failed award is retried by the next heartbeat.
 *
 * Time is the server's `Date.now()` (the heartbeat's only clock), moved by
 * the test. Skipped when no database is reachable at DATABASE_URL.
 */
const prisma = new PrismaService();
let available = true;
let gamification: GamificationService;
const S = 1000;
const MIN = 60 * S;

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveAttendance', 'xpRule']);
  if (!available) return;
  await prisma.onModuleInit();
  // The rule the reference data ships for LIVE_ATTENDED.
  await prisma.xpRule.upsert({
    where: { event: 'LIVE_ATTENDED' },
    create: { event: 'LIVE_ATTENDED', xp: 50, coins: 25, dailyCap: 0, perEntityLimit: 1 },
    update: { isActive: true },
  });
  gamification = new GamificationService(
    prisma,
    new GamificationConfigService(prisma),
    new AchievementsService(prisma),
    new MissionsService(prisma),
    new LeaderboardService(prisma),
    { create: jest.fn(async () => ({})), pushUnread: jest.fn() } as any,
  );
}, 30_000);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

function service(closeRoom: jest.Mock = jest.fn(async () => 'deleted'), g: any = gamification) {
  const daily = {
    closeRoom,
    meetingToken: jest.fn(async () => 'tok'),
  };
  const realtime = { emitToLive: jest.fn(), emitToUser: jest.fn() };
  const svc = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    g,
    dailyProviders(daily),
    realtime as any,
    {} as any,
    {} as any,
  );
  return { svc, daily, realtime, closeRoom };
}

/** A running class (started 10 minutes ago, 60 minutes long) and one booked student. */
async function world(session: Record<string, unknown> = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `bt-${k}@it.test` },
  });
  const student = await prisma.user.create({
    data: { role: 'STUDENT', fullName: `S ${k}`, email: `bs-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `bt-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `ba-${k}`, name: `A ${k}`, ownerUserId: teacher.id },
  });
  const sp = await prisma.studentProfile.create({ data: { userId: student.id } });
  const T0 = Date.now();
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(T0 - 10 * MIN),
      startedAt: new Date(T0 - 11 * MIN),
      durationMin: 60,
      status: 'LIVE',
      roomName: `darsly-bt-${k}`,
      roomUrl: `https://x.daily.co/darsly-bt-${k}`,
      ...session,
    },
  });
  await prisma.liveBooking.create({ data: { sessionId: ls.id, studentId: sp.id } });
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { T0, teacher, student, sp, ls, scope };
}

/** Put the student in the room at a given server time, with some attendance already. */
async function present(w: Awaited<ReturnType<typeof world>>, at: number, seconds = 0) {
  return prisma.liveAttendance.upsert({
    where: { sessionId_userId: { sessionId: w.ls.id, userId: w.student.id } },
    create: {
      sessionId: w.ls.id,
      userId: w.student.id,
      role: 'STUDENT',
      joinedAt: new Date(at),
      lastSeenAt: new Date(at),
      durationSeconds: seconds,
    },
    update: { lastSeenAt: new Date(at), durationSeconds: seconds, leftAt: null },
  });
}

/** A heartbeat as if it reached the server at `at`. */
async function beatAt(svc: LiveService, w: Awaited<ReturnType<typeof world>>, at: number) {
  jest.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return await svc.heartbeat(w.student.id, w.ls.id);
  } finally {
    jest.restoreAllMocks();
  }
}

const attended = async (w: Awaited<ReturnType<typeof world>>) =>
  (
    await prisma.liveAttendance.findUniqueOrThrow({
      where: { sessionId_userId: { sessionId: w.ls.id, userId: w.student.id } },
    })
  ).durationSeconds;

// ── L10: the arithmetic ──────────────────────────────────────────────────────

describe('L10 on Postgres: what a heartbeat credits', () => {
  it('the worked example: 30s + 30s, a four-minute drop-out is not counted', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    const t = w.T0; // "10:00:00" — the student is in the room
    await present(w, t);
    await beatAt(svc, w, t + 30 * S); // 10:00:30  +30
    await beatAt(svc, w, t + 60 * S); // 10:01:00  +30
    //                                     … the laptop closes …
    await beatAt(svc, w, t + 300 * S); // 10:05:00  gap 240s > 90s → +0
    expect(await attended(w)).toBe(60);
    await beatAt(svc, w, t + 330 * S); // back, and counting again  +30
    expect(await attended(w)).toBe(90);
  });

  it('a gap just inside the grace is counted, just outside it is not', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    await beatAt(svc, w, w.T0 + 90 * S);
    expect(await attended(w)).toBe(90);
    await beatAt(svc, w, w.T0 + 90 * S + 91 * S);
    expect(await attended(w)).toBe(90);
  });

  it('a duplicate (the same request twice) counts once', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    await beatAt(svc, w, w.T0 + 30 * S);
    await beatAt(svc, w, w.T0 + 30 * S);
    await beatAt(svc, w, w.T0 + 30 * S + 400); // a retry 0.4s later
    expect(await attended(w)).toBe(30);
  });

  it('a delayed request that lands after a newer one adds nothing and does not move time back', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    await beatAt(svc, w, w.T0 + 60 * S);
    await beatAt(svc, w, w.T0 + 45 * S); // older server time, applied later
    expect(await attended(w)).toBe(60);
    const row = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(row.lastSeenAt.getTime()).toBe(w.T0 + 60 * S);
  });

  it('two tabs beating out of step count real time once', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    // Tab A at :30, :60, :90; tab B at :15, :45, :75 — 90 real seconds.
    for (const s of [15, 30, 45, 60, 75, 90]) await beatAt(svc, w, w.T0 + s * S);
    expect(await attended(w)).toBe(90);
  });

  it('two tabs (or two replicas) at the same instant: concurrent requests count once', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    jest.spyOn(Date, 'now').mockReturnValue(w.T0 + 30 * S);
    // Ten concurrent requests, each on its own pooled connection.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => svc.heartbeat(w.student.id, w.ls.id)),
    );
    jest.restoreAllMocks();
    expect(results.every((r) => r.ok)).toBe(true);
    // The old read-then-write credited 30s per request here: 300s.
    expect(await attended(w)).toBe(30);
  });

  it('never counts past the effective end, and does not reopen a closed row', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    const end = w.ls.startsAt.getTime() + 60 * MIN;
    await present(w, end - 10 * S);
    await beatAt(svc, w, end + 20 * S); // 10s were inside the class
    expect(await attended(w)).toBe(10);
    await beatAt(svc, w, end + 50 * S);
    expect(await attended(w)).toBe(10);
    const row = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    // The class ran out of time with the row still open: closed at the end.
    expect(row.leftAt?.getTime()).toBe(end);
  });

  it('after the teacher ends the class, a heartbeat counts nothing and leaves the row closed', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0);
    const endedAt = new Date(w.T0 + 20 * S);
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { status: 'ENDED', endedAt },
    });
    await prisma.liveAttendance.updateMany({
      where: { sessionId: w.ls.id },
      data: { leftAt: endedAt },
    });
    await beatAt(svc, w, w.T0 + 30 * S);
    expect(await attended(w)).toBe(20); // up to endedAt, not to the heartbeat
    const row = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(row.leftAt?.getTime()).toBe(endedAt.getTime());
  });
});

// ── L10: the reward ──────────────────────────────────────────────────────────

describe('L10 on Postgres: LIVE_ATTENDED', () => {
  const events = (w: Awaited<ReturnType<typeof world>>) =>
    prisma.gamificationEvent.findMany({
      where: { idempotencyKey: `LIVE_ATTENDED:${w.sp.id}:${w.ls.id}` },
    });
  const xp = async (w: Awaited<ReturnType<typeof world>>) =>
    (await prisma.studentGamification.findUnique({ where: { studentId: w.sp.id } }))?.xp ?? 0;

  it('asking for a token is not attending', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 5 * MIN) });
    const { svc } = service();
    await svc.join(w.student.id, w.ls.id);
    await svc.join(w.student.id, w.ls.id);
    expect(await events(w)).toHaveLength(0);
  });

  it('below the threshold: nothing', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0, 540);
    await beatAt(svc, w, w.T0 + 30 * S); // 570 < 600
    expect(await events(w)).toHaveLength(0);
  });

  it('attendance accumulated across a reconnect crosses it', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0, 0);
    await prisma.liveAttendance.updateMany({
      where: { sessionId: w.ls.id },
      data: { durationSeconds: 3 * 60 },
    }); // three minutes, then the Wi-Fi dropped
    await present(w, w.T0 + 10 * MIN, 3 * 60 + 7 * 60 - 30); // rejoined; seven more, less one beat
    await beatAt(svc, w, w.T0 + 10 * MIN + 30 * S); // 3 + 7 = 10 minutes
    expect(await attended(w)).toBe(600);
    expect(await events(w)).toHaveLength(1);
  });

  it('eight heartbeats crossing it at the same moment pay exactly once', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    await present(w, w.T0, 570);
    const before = await xp(w);
    jest.spyOn(Date, 'now').mockReturnValue(w.T0 + 30 * S);
    await Promise.all(Array.from({ length: 8 }, () => svc.heartbeat(w.student.id, w.ls.id)));
    jest.restoreAllMocks();
    expect(await attended(w)).toBe(600);
    expect(await events(w)).toHaveLength(1);
    expect((await xp(w)) - before).toBe(50);
  });

  it('a failed award keeps the attendance, and the next heartbeat pays it — once', async () => {
    if (!guard()) return;
    const w = await world();
    const flaky = {
      recordOrThrow: jest
        .fn()
        .mockRejectedValueOnce(new Error('gamification down'))
        .mockImplementation((i: any) => gamification.recordOrThrow(i)),
    };
    const { svc } = service(undefined, flaky);
    await present(w, w.T0, 590);
    const first = await beatAt(svc, w, w.T0 + 30 * S);
    expect(first.ok).toBe(true);
    expect(await attended(w)).toBe(620);
    expect(await events(w)).toHaveLength(0);

    await beatAt(svc, w, w.T0 + 60 * S);
    await beatAt(svc, w, w.T0 + 90 * S);
    expect(await attended(w)).toBe(680);
    expect(await events(w)).toHaveLength(1);
    // The third heartbeat found it paid and did not try again.
    expect(flaky.recordOrThrow).toHaveBeenCalledTimes(2);
  });
});

// ── L7 ───────────────────────────────────────────────────────────────────────

describe('L7 on Postgres: extending', () => {
  const endOf = async (id: string) => {
    const s = await prisma.liveSession.findUniqueOrThrow({ where: { id } });
    return s.startsAt.getTime() + s.durationMin * MIN;
  };

  it('two "+15" at once serialise on the row lock: +30, never a lost update', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc, realtime, daily } = service();
    const start = await endOf(w.ls.id);
    const [a, b] = await Promise.all([
      svc.extend(w.scope, w.ls.id, 15),
      svc.extend(w.scope, w.ls.id, 15),
    ]);
    expect(await endOf(w.ls.id)).toBe(start + 30 * MIN);
    expect([a.endsAt.getTime(), b.endsAt.getTime()].sort()).toEqual([
      start + 15 * MIN,
      start + 30 * MIN,
    ]);
    expect(realtime.emitToLive).toHaveBeenCalledTimes(2);
    expect(daily.closeRoom).not.toHaveBeenCalled(); // an extension touches no provider
  });

  it('two tabs showing the same end: one extends, the other is told it already moved', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc } = service();
    const start = await endOf(w.ls.id);
    const expectedEndsAt = new Date(start).toISOString();
    const results = await Promise.allSettled([
      svc.extend(w.scope, w.ls.id, 15, { expectedEndsAt }),
      svc.extend(w.scope, w.ls.id, 15, { expectedEndsAt }),
    ]);
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.getResponse()).toMatchObject({ code: 'TIMING_CHANGED' });
    expect(await endOf(w.ls.id)).toBe(start + 15 * MIN);
  });

  it('beyond the old 30-minute grace: +60, and neither the old end nor old+30 ends it', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc, daily } = service();
    const start = await endOf(w.ls.id);
    for (let i = 0; i < 4; i++) await svc.extend(w.scope, w.ls.id, 15);
    expect(await endOf(w.ls.id)).toBe(start + 60 * MIN);
    for (const at of [start + 1000, start + 30 * MIN + 1000]) {
      jest.spyOn(Date, 'now').mockReturnValue(at);
      expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('not-due');
      jest.restoreAllMocks();
    }
    expect(daily.closeRoom).not.toHaveBeenCalled();
    jest.spyOn(Date, 'now').mockReturnValue(start + 60 * MIN + 1000);
    expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('ended');
    jest.restoreAllMocks();
    expect(daily.closeRoom).toHaveBeenCalledTimes(1);
  });

  it('a student who missed the socket event and refreshes gets the new end', async () => {
    if (!guard()) return;
    const w = await world();
    const { svc, daily } = service();
    const start = await endOf(w.ls.id);
    await svc.extend(w.scope, w.ls.id, 15);
    const res: any = await svc.join(w.student.id, w.ls.id);
    expect(res.session.endsAt.getTime()).toBe(start + 15 * MIN);
    expect((daily.meetingToken.mock.calls[0] as any)[0].endsAtMs).toBe(start + 15 * MIN);
  });
});

describe('L7 on Postgres: Darsly ends the class', () => {
  const row = (id: string) => prisma.liveSession.findUniqueOrThrow({ where: { id } });
  const endOf = (s: { startsAt: Date; durationMin: number }) =>
    s.startsAt.getTime() + s.durationMin * MIN;

  it('at its end: room closed, ENDED at the scheduled end, attendance closed, class told', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 });
    await present(w, Date.now() - 2 * MIN, 1200);
    const { svc, daily, realtime } = service();
    expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('ended');
    const s = await row(w.ls.id);
    expect(s.status).toBe('ENDED');
    expect(s.endedAt?.getTime()).toBe(endOf(s));
    expect(daily.closeRoom).toHaveBeenCalledWith(w.ls.roomName);
    const a = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(a.leftAt?.getTime()).toBe(endOf(s));
    expect(a.durationSeconds).toBe(1200); // nothing added by ending
    expect(realtime.emitToLive).toHaveBeenCalledWith(w.ls.id, 'live:ended', { sessionId: w.ls.id });
    // A retry is a no-op.
    expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('already-ended');
    expect(daily.closeRoom).toHaveBeenCalledTimes(1);
  });

  it('extension vs the old end, racing: the extension holds the lock — the class stays LIVE', async () => {
    if (!guard()) return;
    // Ends 300ms from now; the teacher extends "at 19:59:59".
    const w = await world({ startsAt: new Date(Date.now() - 60 * MIN + 300), durationMin: 60 });
    const { svc, daily } = service();
    // Keep the extension inside its lock for a while (its teacher-conflict read).
    const real = prisma.groupSession.findFirst.bind(prisma.groupSession);
    const slow = jest.spyOn(prisma.groupSession, 'findFirst').mockImplementation((async (
      a: any,
    ) => {
      await new Promise((r) => setTimeout(r, 800));
      return real(a);
    }) as any);
    const ext = svc.extend(w.scope, w.ls.id, 15);
    await new Promise((r) => setTimeout(r, 400)); // the old end has now passed
    const end = svc.endSession(w.ls.id, 'SCHEDULED_END'); // waits on the lock
    const [t, e] = await Promise.all([ext, end]);
    slow.mockRestore();
    expect(e.outcome).toBe('not-due'); // read the NEW end after the lock
    expect((await row(w.ls.id)).status).toBe('LIVE');
    expect(t.endsAt.getTime()).toBe(endOf(await row(w.ls.id)));
    expect(daily.closeRoom).not.toHaveBeenCalled();
  });

  it('the end wins first: the extension that arrives after cannot resurrect the class', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 60 * MIN + 200), durationMin: 60 });
    const closeRoom = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 800)); // the end holds the lock
      return 'deleted';
    });
    const { svc } = service(closeRoom);
    await new Promise((r) => setTimeout(r, 300));
    const end = svc.endSession(w.ls.id, 'SCHEDULED_END');
    await new Promise((r) => setTimeout(r, 100));
    const ext = svc.extend(w.scope, w.ls.id, 15).catch((e) => e);
    const [e, x] = await Promise.all([end, ext]);
    expect(e.outcome).toBe('ended');
    expect(x.getResponse().code).toMatch(/ENDED|SESSION_NOT_LIVE/);
    const s = await row(w.ls.id);
    expect(s.status).toBe('ENDED');
    expect(s.durationMin).toBe(60);
  });

  it("the teacher's End and the sweep at the same moment: one end, one room close", async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 });
    await present(w, Date.now() - 2 * MIN, 300);
    const closeRoom = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'deleted';
    });
    const { svc, realtime } = service(closeRoom);
    const [m, s] = await Promise.all([
      svc.end(w.scope, w.ls.id),
      svc.endSession(w.ls.id, 'SCHEDULED_END'),
    ]);
    expect(closeRoom).toHaveBeenCalledTimes(1);
    expect(m.status).toBe('ENDED');
    expect(['ended', 'already-ended']).toContain(s.outcome);
    const ended = realtime.emitToLive.mock.calls.filter((c: any) => c[1] === 'live:ended');
    expect(ended).toHaveLength(1);
    const a = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(a.durationSeconds).toBe(300);
    expect(a.leftAt).toBeInstanceOf(Date);
  });

  it('the provider refuses: the class stays LIVE, and the next sweep closes it', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 });
    process.env.DAILY_API_KEY = 'test-key';
    const realFetch = global.fetch;
    const replies: Array<() => Promise<any>> = [
      async () => ({ ok: false, status: 500, text: async () => 'upstream error' }),
      async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      async () => ({ ok: true, status: 200, json: async () => ({ deleted: true }) }),
    ];
    const sent: string[] = [];
    global.fetch = jest.fn(async (url: string, init: any) => {
      sent.push(`${init.method} ${url}`);
      return replies.shift()!();
    }) as any;
    try {
      const provider = new DailyService();
      const { svc, realtime } = service(jest.fn((n: string) => provider.closeRoom(n)) as any);
      const e1 = await svc.endSession(w.ls.id, 'SCHEDULED_END').catch((e) => e);
      expect(e1.getResponse()).toMatchObject({ code: 'LIVE_PROVIDER_ERROR' });
      const e2 = await svc.endSession(w.ls.id, 'SCHEDULED_END').catch((e) => e);
      expect(e2.getResponse()).toMatchObject({ code: 'LIVE_PROVIDER_UNREACHABLE' });
      expect((await row(w.ls.id)).status).toBe('LIVE'); // never ENDED with a room still open
      expect(realtime.emitToLive).not.toHaveBeenCalled();
      expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('ended');
      expect((await row(w.ls.id)).status).toBe('ENDED');
      expect(sent).toEqual(Array(3).fill(`DELETE https://api.daily.co/v1/rooms/${w.ls.roomName}`));
    } finally {
      global.fetch = realFetch;
      delete process.env.DAILY_API_KEY;
    }
  });

  it('a room already gone (404) counts as closed', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 });
    const { svc } = service(jest.fn(async () => 'already-gone') as any);
    expect((await svc.endSession(w.ls.id, 'SCHEDULED_END')).outcome).toBe('ended');
  });

  it('recovery: the worker was down at the end — the next sweep finds it and ends it', async () => {
    if (!guard()) return;
    // Ended 20 minutes ago by the clock; nobody was running to close it.
    const w = await world({ startsAt: new Date(Date.now() - 80 * MIN), durationMin: 60 });
    await present(w, Date.now() - 25 * MIN, 900);
    const notYet = await world(); // still running: must be left alone
    const extended = await world({ startsAt: new Date(Date.now() - 70 * MIN), durationMin: 75 });
    const { svc, daily } = service();
    const worker = new LiveEndWorker(svc);

    const overdue = await svc.overdueLiveSessionIds(100);
    expect(overdue).toContain(w.ls.id);
    expect(overdue).not.toContain(notYet.ls.id);
    expect(overdue).not.toContain(extended.ls.id);

    // Two replicas sweeping at once close it once. (Oldest first, a batch at
    // a time: on a shared test database older overdue classes may come first,
    // so both replicas keep sweeping until this one's turn.)
    let ended = 0;
    for (let i = 0; i < 40 && (await row(w.ls.id)).status !== 'ENDED'; i++) {
      const [r1, r2] = await Promise.all([worker.sweep(), new LiveEndWorker(svc).sweep()]);
      ended += r1.ended + r2.ended;
    }
    expect(ended).toBeGreaterThanOrEqual(1);
    expect(daily.closeRoom.mock.calls.filter((c: any) => c[0] === w.ls.roomName)).toHaveLength(1);
    const s = await row(w.ls.id);
    expect(s.status).toBe('ENDED');
    expect(s.endedAt?.getTime()).toBe(endOf(s)); // the class's end, not the sweep's time
    const a = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(a.leftAt?.getTime()).toBe(endOf(s));
    expect((await row(notYet.ls.id)).status).toBe('LIVE');
    expect((await row(extended.ls.id)).status).toBe('LIVE');
    expect(await svc.overdueLiveSessionIds(100)).not.toContain(w.ls.id);
  });

  it('attendance after an automatic end counts nothing', async () => {
    if (!guard()) return;
    const w = await world({ startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 });
    const end = w.ls.startsAt.getTime() + 60 * MIN;
    await present(w, end - 20 * S, 0);
    const { svc } = service();
    await svc.endSession(w.ls.id, 'SCHEDULED_END');
    await beatAt(svc, w, end + 10 * S);
    // Up to the end (20s), nothing after.
    expect(await attended(w)).toBe(20);
  });
});
