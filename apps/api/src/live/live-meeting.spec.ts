import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DailyService } from './daily.service';
import { JOIN_OPENS_MIN, LiveService, PRESENCE_GRACE_SEC } from './live.service';

/**
 * Who gets into the classroom, and what the room remembers about it.
 *
 * The rules here are the ones a URL cannot be trusted with: a private room's
 * address is not a secret worth anything once it has been forwarded, so every
 * decision — booked, started, inside the window, teacher or student — is made
 * here and expressed as a token minted for one person. These tests are mostly
 * about the refusals, because a gate that only ever says yes is not a gate.
 */

const MIN = 60_000;

type Session = {
  id: string;
  tenantId: string;
  title?: string;
  startsAt: Date;
  durationMin?: number;
  status?: 'SCHEDULED' | 'LIVE' | 'ENDED';
  roomName?: string | null;
  roomUrl?: string | null;
  joinUrl?: string | null;
  deletedAt?: Date | null;
  startedAt?: Date | null;
};

function build(world: {
  session?: Session;
  booked?: boolean;
  otherLiveCount?: number;
  attendance?: any;
  dailyFails?: boolean;
}) {
  const s = world.session && {
    title: 'الجبر',
    durationMin: 60,
    status: 'SCHEDULED' as const,
    roomName: null,
    roomUrl: null,
    joinUrl: null,
    deletedAt: null,
    ...world.session,
  };

  const updated: any[] = [];
  const upserted: any[] = [];
  const prisma = {
    liveSession: {
      findFirst: jest.fn(async ({ where }: any) =>
        s && s.id === where.id && (where.tenantId === undefined || s.tenantId === where.tenantId) ? { ...s } : null,
      ),
      findUnique: jest.fn(async () => (s ? { ...s } : null)),
      updateMany: jest.fn(async ({ data }: any) => {
        // Mirrors the real `status: { not: 'LIVE' }` claim: a session already
        // live is not claimed a second time.
        if (s!.status === 'LIVE') return { count: 0 };
        Object.assign(s!, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(s!, data);
        updated.push(data);
        return { ...s };
      }),
      count: jest.fn(async () => world.otherLiveCount ?? 0),
    },
    liveBooking: {
      findUnique: jest.fn(async () => (world.booked ? { id: 'b1', session: { ...s } } : null)),
      // Who gets told the class has started.
      findMany: jest.fn(async () => (world.booked ? [{ student: { userId: 'su_1' } }] : [])),
    },
    liveAttendance: {
      findUnique: jest.fn(async () => world.attendance ?? null),
      upsert: jest.fn(async (args: any) => {
        upserted.push(args);
        return {};
      }),
      update: jest.fn(async ({ data }: any) => {
        updated.push(data);
        return {};
      }),
      updateMany: jest.fn(async ({ data }: any) => {
        updated.push(data);
        return { count: 1 };
      }),
      findMany: jest.fn(async () => []),
    },
    studentProfile: {
      findUnique: jest.fn(async () => ({ id: 'st_1', user: { fullName: 'طالب' } })),
    },
    user: { findUnique: jest.fn(async () => ({ fullName: 'أ. أحمد' })) },
    teacherProfile: { findUnique: jest.fn(async () => ({ userId: 'tu_1' })) },
    $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma))),
  } as unknown as PrismaService;

  const daily = {
    configured: true,
    createRoom: jest.fn(async (name: string) =>
      world.dailyFails
        ? Promise.reject(new Error('provider down'))
        : { name, url: `https://darsly.daily.co/${name}` },
    ),
    meetingToken: jest.fn(async () => 'tok_abc'),
    deleteRoom: jest.fn(async () => undefined),
  } as unknown as DailyService;

  const notifications = { create: jest.fn(async () => ({})) } as any;
  const gamification = { record: jest.fn(async () => ({})) } as any;
  const realtime = { emitToLive: jest.fn() } as any;
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job_1' })) } as any;
  const service = new LiveService(prisma, notifications, gamification, daily, realtime, jobs);
  return { service, prisma, daily, notifications, realtime, jobs, session: s, updated, upserted };
}

describe('a teacher opens the classroom', () => {
  it('creates the room and hands back an owner token', async () => {
    const { service, daily } = build({
      session: { id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() + 5 * MIN) },
    });
    const res = await service.start('t1', 'ls1', 'u_teacher');
    expect(daily.createRoom).toHaveBeenCalledWith('darsly-ls1', expect.any(Number));
    expect(res.participant.role).toBe('TEACHER');
    expect(res.meeting?.url).toContain('darsly.daily.co');
    expect(res.meeting?.token).toBe('tok_abc');
    // Owner is decided here, never asked for — it is what allows moderation.
    expect((daily.meetingToken as jest.Mock).mock.calls[0][0].isOwner).toBe(true);
  });

  it('refuses a session belonging to another academy, as a 404', async () => {
    const { service } = build({
      session: { id: 'ls1', tenantId: 'other', startsAt: new Date(Date.now() + 5 * MIN) },
    });
    // Not 403: the existing convention is that another tenant's session simply
    // does not exist, because 403 would confirm that it does.
    await expect(service.start('t1', 'ls1', 'u')).rejects.toThrow(NotFoundException);
  });

  it('refuses to start before the doors open', async () => {
    const { service } = build({
      session: { id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() + 3 * 3600_000) },
    });
    const err = await service.start('t1', 'ls1', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'TOO_EARLY' });
  });

  it('refuses to start a session whose window has closed', async () => {
    const { service } = build({
      session: { id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() - 5 * 3600_000) },
    });
    const err = await service.start('t1', 'ls1', 'u').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ENDED' });
  });

  it('starting twice is the same room, not a second one', async () => {
    // The refresh case, and the two-tabs case.
    const { service, daily } = build({
      session: {
        id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() + 5 * MIN),
        status: 'LIVE', roomName: 'darsly-ls1', roomUrl: 'https://darsly.daily.co/darsly-ls1',
      },
    });
    await service.start('t1', 'ls1', 'u');
    expect(daily.createRoom).not.toHaveBeenCalled();
  });

  it('refuses a second live session while one is already running', async () => {
    const { service, session } = build({
      session: { id: 'ls2', tenantId: 't1', startsAt: new Date(Date.now() + 5 * MIN) },
      otherLiveCount: 1,
    });
    const err = await service.start('t1', 'ls2', 'u').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ALREADY_LIVE' });
    // And the slot it optimistically claimed is handed back.
    expect(session!.status).toBe('SCHEDULED');
  });

  it('reopens a class the teacher ended by mistake, inside its window', async () => {
    // Tapping "end for all" two minutes into an hour is a slip, not a decision
    // to throw the lesson away and make everyone rebook.
    const { service, daily } = build({
      session: {
        id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() - 2 * MIN),
        durationMin: 60, status: 'ENDED', roomName: null, roomUrl: null,
      },
    });
    const res = await service.start('t1', 'ls1', 'u');
    expect(res.participant.role).toBe('TEACHER');
    // The old room was deleted when it ended, so this is a fresh one.
    expect(daily.createRoom).toHaveBeenCalled();
  });

  it('will not reopen one whose window has closed', async () => {
    const { service } = build({
      session: {
        id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() - 5 * 3600_000),
        status: 'ENDED',
      },
    });
    const err = await service.start('t1', 'ls1', 'u').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ENDED' });
  });

  it('does not leave a session LIVE when the provider fails', async () => {
    const { service, session } = build({
      session: { id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() + 5 * MIN) },
      dailyFails: true,
    });
    await expect(service.start('t1', 'ls1', 'u')).rejects.toThrow();
    // Otherwise the card would offer "join" for a room that was never made.
    expect(session!.status).toBe('SCHEDULED');
    expect(session!.startedAt).toBeNull();
  });
});

describe('the configured domain is checked, not assumed', () => {
  // Uses the real service, because this is about what it does with the
  // provider's answer rather than about how the call is wired.
  const svc = () => new (require('./daily.service').DailyService)();
  const check = (s: any, url: string) => s['assertExpectedDomain'](url);

  afterEach(() => {
    delete process.env.DAILY_DOMAIN;
  });

  it('accepts a room on the domain we expect', () => {
    process.env.DAILY_DOMAIN = 'darsly.daily.co';
    expect(() => check(svc(), 'https://darsly.daily.co/darsly-ls1')).not.toThrow();
  });

  it('refuses a room on somebody else\'s domain', () => {
    // The mistake that otherwise looks like success: a key from another team
    // works perfectly and hosts your classes somewhere you do not control.
    process.env.DAILY_DOMAIN = 'darsly.daily.co';
    const err = (() => { try { check(svc(), 'https://someoneelse.daily.co/x'); } catch (e) { return e as any; } })();
    expect(err.getResponse()).toMatchObject({ code: 'LIVE_DOMAIN_MISMATCH' });
  });

  it('tolerates the variable being written as a URL', () => {
    process.env.DAILY_DOMAIN = 'https://darsly.daily.co/';
    expect(() => check(svc(), 'https://darsly.daily.co/darsly-ls1')).not.toThrow();
  });

  it('checks nothing when the variable is unset', () => {
    // Nothing to compare against is not the same as a mismatch, and refusing
    // here would break every deployment that never set it.
    expect(() => check(svc(), 'https://anything.daily.co/x')).not.toThrow();
  });
});

describe('a student enters the classroom', () => {
  const live = (over: Partial<Session> = {}): Session => ({
    id: 'ls1',
    tenantId: 't1',
    startsAt: new Date(Date.now() + 5 * MIN),
    status: 'LIVE',
    roomName: 'darsly-ls1',
    roomUrl: 'https://darsly.daily.co/darsly-ls1',
    ...over,
  });

  it('lets a booked student in once the teacher has started', async () => {
    const { service, daily } = build({ session: live(), booked: true });
    const res = await service.join('u_student', 'ls1');
    expect(res.participant.role).toBe('STUDENT');
    expect(res.meeting?.token).toBe('tok_abc');
    // A student is never an owner: that is what would let them mute the class.
    expect((daily.meetingToken as jest.Mock).mock.calls[0][0].isOwner).toBe(false);
  });

  it('refuses a student who never booked', async () => {
    const { service } = build({ session: live(), booked: false });
    await expect(service.join('u_student', 'ls1')).rejects.toThrow(ForbiddenException);
  });

  it('refuses before the doors open', async () => {
    const { service } = build({
      session: live({ startsAt: new Date(Date.now() + (JOIN_OPENS_MIN + 10) * MIN) }),
      booked: true,
    });
    const err = await service.join('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_OPEN_YET' });
  });

  it('refuses after the session has ended', async () => {
    const { service } = build({
      session: live({ startsAt: new Date(Date.now() - 5 * 3600_000) }),
      booked: true,
    });
    const err = await service.join('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ENDED' });
  });

  it('will not let a student in before the teacher has started', async () => {
    // There is no room yet, so a join button here would lead nowhere.
    const { service } = build({
      session: live({ status: 'SCHEDULED', roomName: null, roomUrl: null }),
      booked: true,
    });
    const err = await service.join('u_student', 'ls1').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_STARTED' });
  });

  it('still sends a Zoom-era session to its own link', async () => {
    // The feature did not take the old way away from anyone already using it.
    const { service } = build({
      session: live({ status: 'SCHEDULED', roomName: null, roomUrl: null, joinUrl: 'https://meet.example/x' }),
      booked: true,
    });
    const res = await service.join('u_student', 'ls1');
    expect(res.externalUrl).toBe('https://meet.example/x');
    expect(res.meeting).toBeNull();
  });
});

describe('attendance is what the room saw, not what the browser claimed', () => {
  it('files one record per person however many times they rejoin', async () => {
    const { service, upserted } = build({
      session: {
        id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() + 5 * MIN),
        status: 'LIVE', roomName: 'darsly-ls1', roomUrl: 'https://x/y',
      },
      booked: true,
    });
    await service.join('u_student', 'ls1');
    await service.join('u_student', 'ls1');
    // Keyed on (session, user), so the second arrival reopens the first row.
    expect(upserted).toHaveLength(2);
    expect(upserted[0].where).toEqual({ sessionId_userId: { sessionId: 'ls1', userId: 'u_student' } });
    expect(upserted[1].update).toMatchObject({ leftAt: null });
  });

  it('credits a heartbeat that arrived on time', async () => {
    const { service, updated } = build({
      attendance: { id: 'a1', lastSeenAt: new Date(Date.now() - 30_000) },
    });
    await service.heartbeat('u', 'ls1');
    expect(updated[0].durationSeconds).toEqual({ increment: 30 });
  });

  it('does not credit the hour a closed laptop was away', async () => {
    // Duration means time in the room. A gap longer than the grace period is
    // absence, and counting it would turn one lesson into a whole evening.
    const { service, updated } = build({
      attendance: { id: 'a1', lastSeenAt: new Date(Date.now() - (PRESENCE_GRACE_SEC + 600) * 1000) },
    });
    await service.heartbeat('u', 'ls1');
    expect(updated[0].durationSeconds).toEqual({ increment: 0 });
  });

  it('ignores a heartbeat from someone who never joined', async () => {
    const { service } = build({ attendance: null });
    expect(await service.heartbeat('u', 'ls1')).toEqual({ ok: false });
  });
});

describe('ending the class', () => {
  it('closes the room and checks everyone still inside out', async () => {
    const { service, daily, updated } = build({
      session: {
        id: 'ls1', tenantId: 't1', startsAt: new Date(Date.now() - 10 * MIN),
        status: 'LIVE', roomName: 'darsly-ls1', roomUrl: 'https://x/y',
      },
    });
    const res = await service.end('t1', 'ls1');
    expect(res.status).toBe('ENDED');
    expect(daily.deleteRoom).toHaveBeenCalledWith('darsly-ls1');
    expect(updated.some((u) => u.leftAt instanceof Date)).toBe(true);
  });

  it('will not end a session belonging to another academy', async () => {
    const { service } = build({
      session: { id: 'ls1', tenantId: 'other', startsAt: new Date() },
    });
    await expect(service.end('t1', 'ls1')).rejects.toThrow(NotFoundException);
  });
});
