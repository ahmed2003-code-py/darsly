import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PERMISSION_KEY } from '../academy/academy-context';
import { ROLE_PERMISSIONS } from '../academy/permissions';
import { DailyService } from './daily.service';
import { LiveEndWorker } from './live-end.worker';
import { LiveController } from './live.controller';
import {
  LIVE_MAX_DURATION_MIN,
  ROOM_SAFETY_BUFFER_MIN,
  roomSafetyExpiryMs,
  tokenExpiryMs,
} from './live-timing';
import {
  LIVE_ATTENDED_MIN_SECONDS,
  LiveScope,
  LiveService,
  liveAttendedThresholdSec,
} from './live.service';

/**
 * Checkpoint B — L7 (Darsly owns the end of a class) and L10 (attendance earns
 * the reward), against mocks. What only a database can prove — the lock that
 * serialises extensions and ends, the single UPDATE that cannot double-count
 * two tabs, the reward paid exactly once under a race, the sweep after a
 * restart — is in live-checkpoint-b.integration.spec.ts.
 */

const MIN = 60_000;
const OWNER: LiveScope = { academyId: 'a1', userId: 'u_teacher', manageAll: true, role: 'OWNER' };

function world(
  over: {
    session?: Record<string, unknown>;
    closeRoom?: jest.Mock;
    teacherBusy?: boolean;
    booked?: boolean;
  } = {},
) {
  const session: any = {
    id: 'ls1',
    tenantId: 't1',
    academyId: 'a1',
    teacherUserId: 'u_teacher',
    title: 'الجبر',
    startsAt: new Date(Date.now() - 50 * MIN),
    durationMin: 60,
    startedAt: new Date(Date.now() - 52 * MIN),
    status: 'LIVE',
    roomName: 'darsly-ls1',
    roomUrl: 'https://x.daily.co/darsly-ls1',
    deletedAt: null,
    endedAt: null,
    ...over.session,
  };
  const writes: any[] = [];
  const tx = {
    $queryRaw: jest.fn(async () => [{ ...session }]),
    liveSession: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(session, data);
        writes.push(data);
        return { ...session };
      }),
    },
    liveAttendance: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma: any = {
    liveSession: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.academyId && where.academyId !== session.academyId ? null : { ...session },
      ),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(session, data);
        writes.push(data);
        return { ...session };
      }),
    },
    groupSession: {
      findFirst: jest.fn(async () => (over.teacherBusy ? { id: 'gs1', academyId: 'a1' } : null)),
    },
    liveBooking: {
      findUnique: jest.fn(async () => (over.booked ? { id: 'b1', session: { ...session } } : null)),
      findMany: jest.fn(async () => [{ student: { userId: 'su1' } }]),
    },
    studentProfile: {
      findUnique: jest.fn(async () => ({ id: 'st1', user: { fullName: 'طالب' } })),
    },
    liveAttendance: { upsert: jest.fn(async () => ({})) },
    gamificationEvent: { findUnique: jest.fn(async () => null) },
    auditLog: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    $queryRaw: jest.fn(async () => []),
  };
  const daily = {
    closeRoom: over.closeRoom ?? jest.fn(async () => 'deleted'),
    createRoom: jest.fn(async (name: string) => ({ name, url: `https://x/${name}` })),
    meetingToken: jest.fn(async () => 'tok'),
  };
  const realtime = { emitToLive: jest.fn(), emitToUser: jest.fn() };
  const gamification = {
    record: jest.fn(async () => ({})),
    recordOrThrow: jest.fn(async () => ({ awarded: true })),
  };
  const service = new LiveService(
    prisma,
    { create: jest.fn(async () => ({})) } as any,
    gamification as any,
    daily as any,
    realtime as any,
    {} as any,
    {} as any,
  );
  return { service, prisma, tx, daily, realtime, gamification, session, writes };
}

const endOf = (s: any) => s.startsAt.getTime() + s.durationMin * MIN;

// ── L7: who ──────────────────────────────────────────────────────────────────

describe('L7: who may extend a class', () => {
  it('is a live.manage route — a student membership has no such grant', () => {
    const perm = Reflect.getMetadata(PERMISSION_KEY, LiveController.prototype.extend);
    expect(perm).toBe('live.manage');
    expect(ROLE_PERMISSIONS.STUDENT).not.toContain('live.manage');
  });

  it("a teacher cannot extend another academy's class (404 before any lock)", async () => {
    const { service, prisma } = world();
    await expect(
      service.extend({ ...OWNER, academyId: 'other' }, 'ls1', 15),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a non-owner teacher is scoped to their own classes, not a colleague's", async () => {
    const { service, prisma } = world();
    await service
      .extend(
        { academyId: 'a1', userId: 'u_colleague', manageAll: false, role: 'TEACHER' },
        'ls1',
        15,
      )
      .catch(() => undefined);
    expect(prisma.liveSession.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'ls1',
      academyId: 'a1',
      teacherUserId: 'u_colleague',
    });
  });
});

// ── L7: extending ────────────────────────────────────────────────────────────

describe('L7: extending a running class', () => {
  it('is a database change — nothing at the provider moves — and then the room is told', async () => {
    const order: string[] = [];
    const { service, tx, realtime, session, daily } = world();
    tx.liveSession.update.mockImplementation(async ({ data }: any) => {
      order.push('db');
      Object.assign(session, data);
      return { ...session };
    });
    realtime.emitToLive.mockImplementation(() => order.push('emit'));
    const oldEnd = endOf(session);

    const timing = await service.extend(OWNER, 'ls1', 15);

    expect(order).toEqual(['db', 'emit']);
    expect(daily.closeRoom).not.toHaveBeenCalled();
    expect(daily.createRoom).not.toHaveBeenCalled();
    expect(session.durationMin).toBe(75);
    expect(timing.endsAt.getTime()).toBe(oldEnd + 15 * MIN);
    expect(timing.serverNow).toBeInstanceOf(Date);
    expect(realtime.emitToLive).toHaveBeenCalledWith(
      'ls1',
      'live:timing-updated',
      expect.objectContaining({ sessionId: 'ls1', endsAt: new Date(oldEnd + 15 * MIN) }),
    );
  });

  it('beyond the old 30-minute grace: +15 four times is +60', async () => {
    const { service, session } = world();
    const oldEnd = endOf(session);
    for (let i = 0; i < 4; i++) await service.extend(OWNER, 'ls1', 15);
    expect(endOf(session)).toBe(oldEnd + 60 * MIN);
  });

  it('holds the row lock: the session is read FOR UPDATE inside the transaction', async () => {
    const { service, tx } = world();
    await service.extend(OWNER, 'ls1', 15);
    const sql = (tx.$queryRaw.mock.calls[0] as any)[0].join('?');
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it.each([
    ['scheduled, not started', { status: 'SCHEDULED', roomName: null }, 'SESSION_NOT_LIVE'],
    ['ended', { status: 'ENDED' }, 'SESSION_NOT_LIVE'],
    // Its time is up, even if the end sweep has not closed it yet: no resurrection.
    [
      'past its end (sweep not yet run)',
      { startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 },
      'ENDED',
    ],
  ])('refuses a class that is %s', async (_, s, code) => {
    const { service, tx } = world({ session: s });
    const err = await service.extend(OWNER, 'ls1', 15).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code });
    expect(tx.liveSession.update).not.toHaveBeenCalled();
  });

  it('a second before its end, it still extends', async () => {
    const { service, session } = world({
      session: { startsAt: new Date(Date.now() - 60 * MIN + 1000), durationMin: 60 },
    });
    const before = endOf(session);
    const t = await service.extend(OWNER, 'ls1', 15);
    expect(t.endsAt.getTime()).toBe(before + 15 * MIN);
  });

  it('refuses a cancelled (deleted) class', async () => {
    const { service, tx } = world();
    tx.$queryRaw.mockResolvedValueOnce([{ deletedAt: new Date() }] as any);
    await expect(service.extend(OWNER, 'ls1', 15)).rejects.toBeInstanceOf(NotFoundException);
  });

  it(`never past the ${LIVE_MAX_DURATION_MIN}-minute ceiling`, async () => {
    const { service, tx } = world({ session: { durationMin: LIVE_MAX_DURATION_MIN - 5 } });
    const err = await service.extend(OWNER, 'ls1', 15).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'EXTENSION_TOO_LONG' });
    expect(tx.liveSession.update).not.toHaveBeenCalled();
  });

  it('never into the teacher’s next session', async () => {
    const { service, tx } = world({ teacherBusy: true });
    const err = await service.extend(OWNER, 'ls1', 15).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'TEACHER_CONFLICT' });
    expect(tx.liveSession.update).not.toHaveBeenCalled();
  });

  it('a page showing a stale end is told the current timing instead of extending again', async () => {
    const { service, tx, session } = world();
    const stale = new Date(endOf(session) - 15 * MIN).toISOString();
    const err = await service.extend(OWNER, 'ls1', 15, { expectedEndsAt: stale }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse();
    expect(body.code).toBe('TIMING_CHANGED');
    expect(body.timing.endsAt.getTime()).toBe(endOf(session));
    expect(tx.liveSession.update).not.toHaveBeenCalled();
  });

  it('the matching end goes through', async () => {
    const { service, session } = world();
    const current = new Date(endOf(session)).toISOString();
    const t = await service.extend(OWNER, 'ls1', 15, { expectedEndsAt: current });
    expect(t.endsAt.getTime()).toBe(Date.parse(current) + 15 * MIN);
  });
});

describe('L7: tokens and refreshes follow the extended end', () => {
  it('a student joining after the extension gets a token for the new end', async () => {
    const { service, daily, session } = world({ booked: true });
    const before = endOf(session);
    await service.extend(OWNER, 'ls1', 15);
    const res: any = await service.join('u_student', 'ls1');
    expect((daily.meetingToken.mock.calls[0] as any)[0].endsAtMs).toBe(before + 15 * MIN);
    // A refresh reads the timing from the join response — no socket needed.
    expect(res.session.endsAt.getTime()).toBe(before + 15 * MIN);
    expect(res.session.startedAt).toEqual(session.startedAt);
    expect(res.session.serverNow).toBeInstanceOf(Date);
  });

  it('rejoining after the original end but inside the extension is allowed', async () => {
    // Scheduled 19:00–20:00, extended to 20:15, now 20:05.
    const { service, daily } = world({
      booked: true,
      session: { startsAt: new Date(Date.now() - 65 * MIN), durationMin: 75 },
    });
    await expect(service.join('u_student', 'ls1')).resolves.toBeDefined();
    expect(daily.meetingToken).toHaveBeenCalled();
  });

  it('without the extension, the same moment is closed', async () => {
    const { service } = world({
      booked: true,
      session: { startsAt: new Date(Date.now() - 65 * MIN), durationMin: 60 },
    });
    const err = await service.join('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ENDED' });
  });
});

describe("L7: a running class's clock only moves through extend", () => {
  it('refuses a duration edit on a live class', async () => {
    const { service, prisma } = world();
    const err = await service.update(OWNER, 'ls1', { durationMin: 90 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'LIVE_TIMING_LOCKED' });
    expect(prisma.liveSession.update).not.toHaveBeenCalled();
  });

  it('still allows the title of a live class to be edited', async () => {
    const { service, prisma } = world();
    await service.update(OWNER, 'ls1', { title: 'عنوان جديد', durationMin: 60 });
    expect(prisma.liveSession.update).toHaveBeenCalled();
  });

  it('a scheduled class can still be retimed freely', async () => {
    const { service, prisma } = world({ session: { status: 'SCHEDULED', roomName: null } });
    await service.update(OWNER, 'ls1', { durationMin: 90 });
    expect(prisma.liveSession.update).toHaveBeenCalled();
  });
});

// ── L7: Darsly ends the class ────────────────────────────────────────────────

describe('L7: endSession — the one way a class ends', () => {
  it('SCHEDULED_END at the end: room closed first, then ENDED at the scheduled end, then announced', async () => {
    const order: string[] = [];
    const closeRoom = jest.fn(async () => {
      order.push('provider');
      return 'deleted';
    });
    const { service, tx, session, realtime, writes } = world({
      closeRoom,
      session: { startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 },
    });
    tx.liveSession.update.mockImplementation(async ({ data }: any) => {
      order.push('db');
      Object.assign(session, data);
      writes.push(data);
      return { ...session };
    });
    const r = await service.endSession('ls1', 'SCHEDULED_END');
    expect(r.outcome).toBe('ended');
    expect(order).toEqual(['provider', 'db']);
    expect(closeRoom).toHaveBeenCalledWith('darsly-ls1');
    // The class's real end, not the moment the sweep got round to it.
    expect(writes[0]).toEqual({ status: 'ENDED', endedAt: new Date(endOf(session)) });
    expect(tx.liveAttendance.updateMany).toHaveBeenCalledWith({
      where: { sessionId: 'ls1', leftAt: null },
      data: { leftAt: new Date(endOf(session)) },
    });
    expect(realtime.emitToLive).toHaveBeenCalledWith('ls1', 'live:ended', { sessionId: 'ls1' });
    expect(realtime.emitToUser).toHaveBeenCalledWith('su1', 'live:ended', { sessionId: 'ls1' });
  });

  it('a stale trigger does nothing: the class was extended and its end is not here yet', async () => {
    // Was due at 20:00; extended to 20:15; the sweep fires at 20:00:05.
    const { service, daily, tx } = world({
      session: { startsAt: new Date(Date.now() - 60 * MIN - 5000), durationMin: 75 },
    });
    expect((await service.endSession('ls1', 'SCHEDULED_END')).outcome).toBe('not-due');
    expect(daily.closeRoom).not.toHaveBeenCalled();
    expect(tx.liveSession.update).not.toHaveBeenCalled();
  });

  it('already ENDED: nothing is done twice', async () => {
    const endedAt = new Date(Date.now() - 5 * MIN);
    const { service, daily, realtime } = world({ session: { status: 'ENDED', endedAt } });
    const r = await service.endSession('ls1', 'SCHEDULED_END');
    expect(r).toEqual({ outcome: 'already-ended', endedAt });
    expect(daily.closeRoom).not.toHaveBeenCalled();
    expect(realtime.emitToLive).not.toHaveBeenCalled();
  });

  it.each([
    ['refuses', new ServiceUnavailableException({ code: 'LIVE_PROVIDER_ERROR' })],
    ['times out', new ServiceUnavailableException({ code: 'LIVE_PROVIDER_UNREACHABLE' })],
  ])('when the provider %s: the class stays LIVE (retried), nothing announced', async (_, err) => {
    const { service, tx, realtime } = world({
      closeRoom: jest.fn().mockRejectedValue(err),
      session: { startsAt: new Date(Date.now() - 61 * MIN), durationMin: 60 },
    });
    await expect(service.endSession('ls1', 'SCHEDULED_END')).rejects.toBe(err);
    expect(tx.liveSession.update).not.toHaveBeenCalled();
    expect(tx.liveAttendance.updateMany).not.toHaveBeenCalled();
    expect(realtime.emitToLive).not.toHaveBeenCalled();
  });

  it('the teacher’s End: now, not the scheduled end; same path', async () => {
    const { service, daily, writes } = world();
    const before = Date.now();
    const res = await service.end(OWNER, 'ls1');
    expect(res.status).toBe('ENDED');
    expect(daily.closeRoom).toHaveBeenCalledWith('darsly-ls1');
    expect(writes[0].endedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('the teacher’s End while the room is down: an error, and the class is still running', async () => {
    const err = new ServiceUnavailableException({ code: 'LIVE_PROVIDER_UNREACHABLE' });
    const { service, session } = world({ closeRoom: jest.fn().mockRejectedValue(err) });
    await expect(service.end(OWNER, 'ls1')).rejects.toBe(err);
    expect(session.status).toBe('LIVE');
  });

  it('an old class nobody ended is closed quietly — no events for an empty room', async () => {
    const { service, realtime } = world({
      session: { startsAt: new Date(Date.now() - 3 * 24 * 60 * MIN), durationMin: 60 },
    });
    expect((await service.endSession('ls1', 'SCHEDULED_END')).outcome).toBe('ended');
    expect(realtime.emitToLive).not.toHaveBeenCalled();
  });
});

describe('L7: the end sweep', () => {
  const sweeper = (ids: string[], endSession: jest.Mock) =>
    new LiveEndWorker({ overdueLiveSessionIds: jest.fn(async () => ids), endSession } as any);

  it('ends every overdue class it finds, and keeps going past one that fails', async () => {
    const endSession = jest
      .fn()
      .mockResolvedValueOnce({ outcome: 'ended' })
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ outcome: 'not-due' });
    const r = await sweeper(['a', 'b', 'c'], endSession).sweep();
    expect(endSession.mock.calls.map((c) => c[1])).toEqual([
      'SCHEDULED_END',
      'SCHEDULED_END',
      'SCHEDULED_END',
    ]);
    expect(r).toEqual({ ended: 1, failed: 1 });
  });

  it('can be switched off per replica', () => {
    process.env.LIVE_END_WORKER_ENABLED = 'false';
    const w = sweeper([], jest.fn());
    w.onModuleInit();
    expect((w as any).timer).toBeNull();
    delete process.env.LIVE_END_WORKER_ENABLED;
  });
});

// ── L7: the provider clocks ──────────────────────────────────────────────────

describe('L7: the room is a safety TTL, not the end of the class', () => {
  it('lies past the longest end any class can reach', () => {
    const startsAt = Date.UTC(2026, 8, 25, 18, 0);
    const longest = startsAt + LIVE_MAX_DURATION_MIN * MIN;
    expect(roomSafetyExpiryMs(startsAt)).toBe(longest + ROOM_SAFETY_BUFFER_MIN * MIN);
    expect(roomSafetyExpiryMs(startsAt)).toBeGreaterThan(longest);
  });

  it('start() creates the room with that TTL', async () => {
    const { service, daily, prisma, session } = world({
      session: { status: 'SCHEDULED', roomName: null, startsAt: new Date(Date.now() + 5 * MIN) },
    });
    prisma.liveSession.updateMany = jest.fn(async () => ({ count: 1 }));
    prisma.liveSession.count = jest.fn(async () => 0);
    prisma.user = { findUnique: jest.fn(async () => ({ fullName: 'T' })) };
    prisma.teacherProfile = { findUnique: jest.fn(async () => ({ language: 'ar' })) };
    await service.start(OWNER, 'ls1', 'u_teacher');
    expect((daily.createRoom.mock.calls[0] as any)[1]).toBe(
      roomSafetyExpiryMs(session.startsAt.getTime()),
    );
  });

  describe('against the provider', () => {
    let calls: { url: string; method: string; body: any }[];
    const provider = (status: number, reply: any) => {
      calls = [];
      global.fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
        return {
          ok: status < 400,
          status,
          json: async () => reply,
          text: async () => JSON.stringify(reply),
        } as any;
      }) as any;
    };
    beforeEach(() => (process.env.DAILY_API_KEY = 'k'));
    afterEach(() => {
      delete process.env.DAILY_API_KEY;
      jest.restoreAllMocks();
    });

    it('createRoom sets exactly the TTL it is given, with eject_at_room_exp', async () => {
      const exp = roomSafetyExpiryMs(Date.UTC(2026, 8, 25, 18, 0));
      provider(200, { name: 'r', url: 'https://darsly.daily.co/r' });
      await new DailyService().createRoom('r', exp);
      const room = calls.find((c) => c.url.endsWith('/rooms'))!;
      expect(room.body.properties.exp).toBe(Math.floor(exp / 1000));
      expect(room.body.properties.eject_at_room_exp).toBe(true);
    });

    it('closeRoom deletes the room', async () => {
      provider(200, { deleted: true, name: 'r' });
      expect(await new DailyService().closeRoom('r')).toBe('deleted');
      expect(calls[0]).toMatchObject({ url: 'https://api.daily.co/v1/rooms/r', method: 'DELETE' });
    });

    it('a room already gone counts as closed', async () => {
      provider(404, { error: 'not-found' });
      expect(await new DailyService().closeRoom('r')).toBe('already-gone');
    });

    it('any other failure is reported, never swallowed', async () => {
      provider(500, { error: 'server-error' });
      await expect(new DailyService().closeRoom('r')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('a token is minted from the session end, and never ejects anyone', async () => {
      const end = Date.UTC(2026, 8, 25, 18, 15);
      provider(200, { token: 't' });
      await new DailyService().meetingToken({
        roomName: 'r',
        userName: 'x',
        userId: 'u',
        isOwner: false,
        endsAtMs: end,
      });
      expect(calls[0].body.properties.exp).toBe(Math.floor(tokenExpiryMs(end) / 1000));
      expect(calls[0].body.properties.eject_at_token_exp).toBeUndefined();
    });
  });
});

// ── L10 ──────────────────────────────────────────────────────────────────────

describe('L10: being handed a token is not attending', () => {
  it('join mints a token and awards nothing', async () => {
    const { service, gamification } = world({
      booked: true,
      session: { startsAt: new Date(Date.now() + 5 * MIN) },
    });
    await service.join('u_student', 'ls1');
    await service.join('u_student', 'ls1');
    expect(gamification.record).not.toHaveBeenCalled();
    expect(gamification.recordOrThrow).not.toHaveBeenCalled();
  });
});

describe('L10: the threshold', () => {
  it(`is ${LIVE_ATTENDED_MIN_SECONDS / 60} minutes, or half of a shorter class`, () => {
    expect(liveAttendedThresholdSec(60)).toBe(600);
    expect(liveAttendedThresholdSec(120)).toBe(600);
    expect(liveAttendedThresholdSec(15)).toBe(450);
    expect(liveAttendedThresholdSec(5)).toBe(150);
  });
});

describe('L10: the reward follows the heartbeat', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    role: 'STUDENT',
    durationSeconds: 100,
    tenantId: 't1',
    title: 'الجبر',
    startsAt: new Date(Date.now() - 30 * MIN),
    durationMin: 60,
    startedAt: new Date(Date.now() - 30 * MIN),
    status: 'LIVE',
    ...over,
  });

  it('below the threshold nothing is attempted — not even a lookup', async () => {
    const { service, prisma, gamification } = world();
    prisma.$queryRaw.mockResolvedValue([row({ durationSeconds: 599 })]);
    await service.heartbeat('u_student', 'ls1');
    expect(prisma.gamificationEvent.findUnique).not.toHaveBeenCalled();
    expect(gamification.recordOrThrow).not.toHaveBeenCalled();
  });

  it('crossing it pays once, under the shared idempotency key', async () => {
    const { service, prisma, gamification } = world();
    prisma.$queryRaw.mockResolvedValue([row({ durationSeconds: 600 })]);
    await service.heartbeat('u_student', 'ls1');
    expect(gamification.recordOrThrow).toHaveBeenCalledTimes(1);
    expect((gamification.recordOrThrow.mock.calls[0] as any)[0]).toMatchObject({
      studentId: 'st1',
      type: 'LIVE_ATTENDED',
      key: 'LIVE_ATTENDED:st1:ls1',
      entityId: 'ls1',
    });
  });

  it('once it exists, later heartbeats only look it up', async () => {
    const { service, prisma, gamification } = world();
    prisma.$queryRaw.mockResolvedValue([row({ durationSeconds: 900 })]);
    prisma.gamificationEvent.findUnique.mockResolvedValue({ id: 'ge1' });
    await service.heartbeat('u_student', 'ls1');
    expect(gamification.recordOrThrow).not.toHaveBeenCalled();
  });

  it('a failing award does not fail the heartbeat, and the next one retries', async () => {
    const { service, prisma, gamification } = world();
    prisma.$queryRaw.mockResolvedValue([row({ durationSeconds: 620 })]);
    gamification.recordOrThrow.mockRejectedValueOnce(new Error('db blip'));
    const first: any = await service.heartbeat('u_student', 'ls1');
    expect(first.ok).toBe(true); // attendance already committed
    await service.heartbeat('u_student', 'ls1');
    expect(gamification.recordOrThrow).toHaveBeenCalledTimes(2);
  });

  it('the teacher’s own attendance is never rewarded', async () => {
    const { service, prisma, gamification } = world();
    prisma.$queryRaw.mockResolvedValue([row({ role: 'TEACHER', durationSeconds: 3600 })]);
    await service.heartbeat('u_teacher', 'ls1');
    expect(gamification.recordOrThrow).not.toHaveBeenCalled();
  });

  it('the heartbeat sends nothing the client could inflate: only who and which session', async () => {
    const { service, prisma } = world();
    prisma.$queryRaw.mockResolvedValue([row()]);
    await service.heartbeat('u_student', 'ls1');
    const values = (prisma.$queryRaw.mock.calls[0] as any).slice(1);
    expect(values).toContain('u_student');
    expect(values).toContain('ls1');
  });
});
