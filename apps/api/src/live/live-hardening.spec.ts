import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AcademySiteConfig } from '../academy-site/academy-site.config';
import { AiClient } from '../academy-site/ai/ai.client';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { PaymentMatchingService } from '../payments/payment-matching.service';
import { DailyService } from './daily.service';
import { LiveSummaryHandler } from './live-summary.handler';
import { LiveScope, LiveService, SUMMARY_STALE_MS } from './live.service';

/**
 * Checkpoint A — the Live bugs found in the architecture audit
 * (docs/architecture/LIVE_COMMERCE_CLASSROOM_ROADMAP.md, L1–L9 and P6).
 *
 * Each block names the bug it pins down. They are written against the
 * behaviour a teacher or student would see, not the implementation: a summary
 * that can be asked for again, a cost that reaches the budget, a booking that
 * is still there after the class.
 */

const MIN = 60_000;
const OWNER: LiveScope = { academyId: 'a1', userId: 'u_owner', manageAll: true, role: 'OWNER' };

/** A LiveService over an in-memory session, with a CAS-faithful updateMany. */
function liveWorld(
  over: {
    session?: Record<string, unknown>;
    activeJob?: boolean;
    enqueue?: jest.Mock;
    booking?: Record<string, unknown> | null;
    booked?: { student: { userId: string } }[];
  } = {},
) {
  const session: any = {
    id: 'ls1',
    tenantId: 't1',
    academyId: 'a1',
    title: 'الجبر',
    startsAt: new Date(Date.now() - 2 * 3600_000),
    durationMin: 60,
    status: 'ENDED',
    deletedAt: null,
    roomName: 'darsly-ls1',
    summaryStatus: 'NOT_STARTED',
    summaryError: null,
    summary: null,
    summaryForStudents: false,
    transcriptStatus: 'NOT_STARTED',
    recordingStatus: 'NOT_STARTED',
    recordingId: null,
    recordingDuration: null,
    updatedAt: new Date(),
    teacher: { userId: 'u_teacher' },
    ...over.session,
  };
  const writes: any[] = [];
  const prisma: any = {
    liveSession: {
      findFirst: jest.fn(async () => ({ ...session })),
      findUnique: jest.fn(async () => ({ ...session })),
      findUniqueOrThrow: jest.fn(async () => ({ ...session })),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(session, data);
        writes.push(data);
        return { ...session };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const st = where.summaryStatus;
        if (typeof st === 'string' && session.summaryStatus !== st) return { count: 0 };
        if (st?.not && session.summaryStatus === st.not) return { count: 0 };
        if (where.updatedAt?.lt && !(session.updatedAt < where.updatedAt.lt)) return { count: 0 };
        Object.assign(session, data, { updatedAt: new Date() });
        writes.push(data);
        return { count: 1 };
      }),
    },
    liveBooking: {
      findUnique: jest.fn(async () => over.booking ?? null),
      findMany: jest.fn(async () => over.booked ?? []),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    liveAttendance: { updateMany: jest.fn(async () => ({ count: 1 })) },
    studentProfile: {
      findUnique: jest.fn(async () => ({ id: 'st1', user: { fullName: 'طالب' } })),
    },
    academyMembership: { findFirst: jest.fn(async () => null) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const jobs = {
    enqueue: over.enqueue ?? jest.fn(async () => ({ id: 'job1' })),
    hasActiveJobFor: jest.fn(async () => !!over.activeJob),
  };
  const daily = {
    deleteRoom: jest.fn(async () => undefined),
    recording: jest.fn(async () => null),
  };
  const realtime = { emitToLive: jest.fn(), emitToUser: jest.fn() };
  const notifications = { create: jest.fn(async () => ({})) };
  const service = new LiveService(
    prisma,
    notifications as any,
    {} as any,
    daily as any,
    realtime as any,
    jobs as any,
    {} as any,
  );
  return { service, prisma, jobs, daily, realtime, notifications, session, writes };
}

// ── L1 — a summary can no longer be stranded in PROCESSING ──────────────────

describe('L1: asking for a summary survives a refusal from the queue', () => {
  it.each([
    [
      'AI is switched off',
      new ServiceUnavailableException({ message: 'off', code: 'AI_DISABLED' }),
    ],
    [
      'the monthly budget is spent',
      new ServiceUnavailableException({ message: 'budget', code: 'AI_BUDGET_REACHED' }),
    ],
    ['the queue itself failed', new Error('connection reset')],
  ])('when %s, the lesson goes back to where it was and can be asked again', async (_, err) => {
    const enqueue = jest.fn().mockRejectedValueOnce(err).mockResolvedValue({ id: 'job2' });
    const { service, session } = liveWorld({ enqueue });

    await expect(service.requestSummary(OWNER, 'ls1')).rejects.toBe(err);
    // Before the fix this read PROCESSING, forever.
    expect(session.summaryStatus).toBe('NOT_STARTED');

    // …and the next press works.
    expect(await service.requestSummary(OWNER, 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(session.summaryStatus).toBe('PROCESSING');
  });

  it('a lesson that had failed before keeps its reason when a retry is refused', async () => {
    const enqueue = jest.fn().mockRejectedValue(new Error('down'));
    const { service, session } = liveWorld({
      enqueue,
      session: { summaryStatus: 'FAILED', summaryError: 'TRANSCRIPT_PENDING' },
    });
    await expect(service.requestSummary(OWNER, 'ls1')).rejects.toThrow('down');
    expect(session.summaryStatus).toBe('FAILED');
    expect(session.summaryError).toBe('TRANSCRIPT_PENDING');
  });

  it('is not refused because some other AI job in the academy is running', async () => {
    const { service, jobs } = liveWorld();
    await service.requestSummary(OWNER, 'ls1');
    // Scoped to this lesson — not the academy-wide lock that clashed with a
    // site generation or an exam import.
    expect(jobs.enqueue.mock.calls[0][3]).toEqual({
      sameInput: { path: 'liveSessionId', equals: 'ls1' },
    });
  });

  it('a second press while a job for this lesson is queued queues nothing', async () => {
    const { service, jobs, session } = liveWorld({
      activeJob: true,
      // The queue's own retry after an AI failure had marked it FAILED.
      session: { summaryStatus: 'FAILED', summaryError: 'AI_FAILED' },
    });
    expect(await service.requestSummary(OWNER, 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(session.summaryStatus).toBe('PROCESSING');
  });

  it('two presses at the same moment queue exactly one job', async () => {
    const { service, jobs } = liveWorld();
    const [a, b] = await Promise.all([
      service.requestSummary(OWNER, 'ls1'),
      service.requestSummary(OWNER, 'ls1'),
    ]);
    expect(a).toEqual({ status: 'PROCESSING' });
    expect(b).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a fresh PROCESSING is left alone (its job is being queued right now)', async () => {
    const { service, jobs } = liveWorld({ session: { summaryStatus: 'PROCESSING' } });
    expect(await service.requestSummary(OWNER, 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('a PROCESSING abandoned with no job behind it can be asked for again', async () => {
    const { service, jobs } = liveWorld({
      session: {
        summaryStatus: 'PROCESSING',
        updatedAt: new Date(Date.now() - SUMMARY_STALE_MS - MIN),
      },
    });
    expect(await service.requestSummary(OWNER, 'ls1')).toEqual({ status: 'PROCESSING' });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('…and if that retry is refused it becomes a failure, not a fresh-looking spinner', async () => {
    const { service, session } = liveWorld({
      enqueue: jest.fn().mockRejectedValue(new Error('down')),
      session: {
        summaryStatus: 'PROCESSING',
        updatedAt: new Date(Date.now() - SUMMARY_STALE_MS - MIN),
      },
    });
    await expect(service.requestSummary(OWNER, 'ls1')).rejects.toThrow('down');
    expect(session.summaryStatus).toBe('FAILED');
    expect(session.summaryError).toBe('ENQUEUE_FAILED');
  });

  it('the teacher is shown a stalled summary as failed, so the page offers a retry', async () => {
    const { service } = liveWorld({
      session: {
        summaryStatus: 'PROCESSING',
        updatedAt: new Date(Date.now() - SUMMARY_STALE_MS - MIN),
      },
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.summary.status).toBe('FAILED');
    expect((d.summary as any).error).toBe('STALLED');
  });

  it('a PROCESSING with a job running is still shown as processing', async () => {
    const { service } = liveWorld({
      activeJob: true,
      session: {
        summaryStatus: 'PROCESSING',
        updatedAt: new Date(Date.now() - SUMMARY_STALE_MS - MIN),
      },
    });
    const d = await service.sessionDetail('u_teacher', 'ls1');
    expect(d.summary.status).toBe('PROCESSING');
  });
});

describe('L1: the queue can scope a clash to one piece of work', () => {
  const build = (active: { academyWide: number; sameInput: number }) => {
    const prisma = {
      aiJob: {
        count: jest.fn(async ({ where }: any) =>
          where.input ? active.sameInput : active.academyWide,
        ),
        aggregate: jest.fn(async () => ({ _sum: { costCents: 0 } })),
        create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      },
    };
    const service = new AiJobService(
      prisma as never,
      {
        enabled: true,
        monthlyBudgetCents: 0,
      } as never,
    );
    return { service, prisma };
  };

  it('queues a summary while an unrelated job holds the academy', async () => {
    const { service, prisma } = build({ academyWide: 1, sameInput: 0 });
    await service.enqueue(
      'a1',
      'LIVE_SUMMARY',
      { liveSessionId: 'ls1' },
      { sameInput: { path: 'liveSessionId', equals: 'ls1' } },
    );
    expect(prisma.aiJob.create).toHaveBeenCalled();
    expect(prisma.aiJob.count).toHaveBeenCalledWith({
      where: {
        type: 'LIVE_SUMMARY',
        status: { in: ['QUEUED', 'RUNNING'] },
        input: { path: ['liveSessionId'], equals: 'ls1' },
      },
    });
  });

  it('refuses a second summary of the same lesson, with a code', async () => {
    const { service } = build({ academyWide: 0, sameInput: 1 });
    const err = await service
      .enqueue(
        'a1',
        'LIVE_SUMMARY',
        { liveSessionId: 'ls1' },
        { sameInput: { path: 'liveSessionId', equals: 'ls1' } },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'AI_JOB_ACTIVE' });
  });

  it('keeps the academy-wide lock for callers that did not ask otherwise', async () => {
    const { service } = build({ academyWide: 1, sameInput: 0 });
    await expect(service.enqueue('a1', 'SITE_GENERATE')).rejects.toBeInstanceOf(ConflictException);
  });

  it('names the refusal when AI is off', async () => {
    const service = new AiJobService({} as never, { enabled: false } as never);
    const err = await service.enqueue('a1', 'LIVE_SUMMARY').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AI_DISABLED' });
  });
});

// ── L2 — the Center pays for its own summaries ──────────────────────────────

describe("L2: a Center lesson's summary is the Center's job", () => {
  it("queues it on the session's academy, not the teacher's personal workspace", async () => {
    const { service, jobs } = liveWorld({
      session: { tenantId: 't_personal', academyId: 'center_1' },
    });
    await service.requestSummary({ ...OWNER, academyId: 'center_1' }, 'ls1');
    expect(jobs.enqueue.mock.calls[0][0]).toBe('center_1');
  });

  it('a legacy session with no academyId still falls back to its author', async () => {
    const { service, jobs } = liveWorld({ session: { tenantId: 't1', academyId: null } });
    await service.requestSummary(OWNER, 'ls1');
    expect(jobs.enqueue.mock.calls[0][0]).toBe('t1');
  });
});

// ── L3 — what a summary cost reaches the job, the budget and the lesson ─────

describe('L3: a summary costs what its calls cost, and says so', () => {
  const config = {
    enabled: true,
    apiKey: 'k',
    model: 'gpt-6-luna',
    // cents per million tokens
    priceInPerMToken: 200,
    priceOutPerMToken: 1000,
  } as unknown as AcademySiteConfig;

  const build = (resp: Record<string, unknown>, priorMillicents = 0) => {
    const logged: any[] = [];
    const prisma: any = {
      liveSession: {
        findUnique: jest.fn(async () => ({
          id: 'ls1',
          tenantId: 't1',
          title: 'الجبر',
          roomName: 'darsly-ls1',
          transcriptText: 'المدرس: '.padEnd(400, 'ا'),
          summaryStatus: 'PROCESSING',
          transcriptStatus: 'NOT_STARTED',
          teacher: { userId: 'u_teacher' },
        })),
        update: jest.fn(async () => ({})),
      },
      aiCallLog: {
        create: jest.fn(async ({ data }: any) => {
          logged.push(data);
          return {};
        }),
        aggregate: jest.fn(async () => ({ _sum: { costMillicents: priorMillicents } })),
      },
      aiJob: { update: jest.fn(async () => ({})) },
    };
    const ai = new AiClient(config, prisma);
    (ai as any).client = { responses: { create: jest.fn().mockResolvedValue(resp) } };
    const handler = new LiveSummaryHandler(
      prisma,
      ai,
      { transcriptFor: jest.fn(), transcriptionAvailable: jest.fn() } as any,
      { create: jest.fn(async () => ({})) } as any,
    );
    return { handler, prisma, logged };
  };

  const ok = {
    id: 'resp_1',
    status: 'completed',
    output_text: JSON.stringify({
      summary: 's',
      topics: [],
      keyPoints: [],
      questionsAndAnswers: [],
      actionItems: [],
    }),
    usage: { input_tokens: 5000, output_tokens: 3000 },
  };
  const job = { id: 'job1', academyId: 'center_1', attempts: 1, input: { liveSessionId: 'ls1' } };

  it('returns the exact cost of its call, which the worker writes onto AiJob.costCents', async () => {
    const { handler, logged } = build(ok);
    const result = await handler.handle(job as any);
    await new Promise((r) => setImmediate(r)); // the call log is written in the background
    // 5000 × 200/M + 3000 × 1000/M = 1 + 3 = 4¢
    expect(logged[0].costMillicents).toBe(4000);
    expect(result).toEqual({ costCents: Math.ceil(logged[0].costMillicents / 1000) });
  });

  it('records the call against the lesson and the job, so it can be read back per session', async () => {
    const { handler, logged } = build(ok);
    await handler.handle(job as any);
    await new Promise((r) => setImmediate(r));
    expect(logged[0]).toEqual(
      expect.objectContaining({ liveSessionId: 'ls1', aiJobId: 'job1', stage: 'LIVE_SUMMARY' }),
    );
    // The model and the prices it was costed at are kept with the call.
    expect(logged[0]).toEqual(
      expect.objectContaining({
        model: 'gpt-6-luna',
        priceInPerMToken: 200,
        priceOutPerMToken: 1000,
      }),
    );
  });

  it('adds what earlier attempts of the same job spent', async () => {
    const { handler, prisma } = build(ok, 2500);
    const result = await handler.handle(job as any);
    expect(prisma.aiCallLog.aggregate).toHaveBeenCalledWith({
      where: { aiJobId: 'job1' },
      _sum: { costMillicents: true },
    });
    expect(result).toEqual({ costCents: Math.ceil((2500 + 4000) / 1000) });
  });

  it("keeps an earlier attempt's charge even if its call-log row has not landed yet", async () => {
    // Attempt 1 charged 7¢ onto the job before it threw; its AiCallLog row is
    // written in the background and is (here) not visible yet.
    const { handler } = build(ok, 0);
    const result = await handler.handle({ ...job, costCents: 7, attempts: 2 } as any);
    expect(result).toEqual({ costCents: Math.ceil((7000 + 4000) / 1000) });
  });

  it('does not add the job charge on top of the log describing the same calls', async () => {
    // Both records say attempt 1 cost 6.2¢ (the job rounded it to 7¢).
    const { handler } = build(ok, 6200);
    const result = await handler.handle({ ...job, costCents: 7, attempts: 2 } as any);
    expect(result).toEqual({ costCents: Math.ceil((7000 + 4000) / 1000) }); // 11, not 18
  });

  it('charges the job for a rejected answer too — it was billed', async () => {
    const { handler, prisma } = build({
      id: 'resp_cut',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '{"summary":',
      usage: { input_tokens: 1000, output_tokens: 6000 },
    });
    await expect(handler.handle(job as any)).rejects.toThrow(/Summary generation failed/);
    // 1000 × 200/M + 6000 × 1000/M = 0.2 + 6 = 6.2¢ → 7¢ on the job
    expect(prisma.aiJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: { costCents: 7 },
    });
  });

  it('a lesson already summarised costs nothing and changes nothing', async () => {
    const { handler, prisma } = build(ok);
    prisma.liveSession.findUnique.mockResolvedValueOnce({
      id: 'ls1',
      summaryStatus: 'READY',
      teacher: { userId: 'u' },
    });
    expect(await handler.handle(job as any)).toBeUndefined();
    expect(prisma.aiCallLog.create).not.toHaveBeenCalled();
  });
});

// ── L4 — nobody is told about a session they can no longer book ─────────────

describe('L4: announcements go to students whose access is still active', () => {
  it('filters on the same "active" the booking path uses', async () => {
    const enrollmentFindMany = jest.fn(async () => [{ student: { userId: 'su1' } }]);
    const prisma: any = {
      groupSession: { findFirst: jest.fn(async () => null) },
      liveSession: {
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: any) => ({ id: 'ls1', ...data })),
      },
      enrollment: { findMany: enrollmentFindMany },
    };
    const academy = {
      assertAssignableTeacher: jest.fn(async () => ({
        userId: 'u_teacher',
        teacherProfileId: 't1',
      })),
    };
    const service = new LiveService(
      prisma,
      { create: jest.fn(async () => ({})) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      academy as any,
    );
    await service.create(OWNER, {
      title: 'مراجعة',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const where = (enrollmentFindMany.mock.calls[0] as any)[0].where;
    expect(where.status).toBe('ACTIVE');
    // An expired monthly subscription is still status ACTIVE — the window is
    // what makes it inactive, and it was missing here.
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });
});

// ── L6 — a lesson's transcript on the second page is still found ────────────

describe('L6: transcripts are looked up past the first page', () => {
  const svc = () => new DailyService();
  const vtt = (line: string) =>
    ['WEBVTT', '', '1', '00:00:01.000 --> 00:00:02.000', line].join('\n');
  let listCalls: string[];

  const daily = (pages: Record<string, { total_count?: number; data: any[] }>) => {
    listCalls = [];
    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/transcript')) {
        const key = u.searchParams.get('starting_after') ?? '';
        listCalls.push(key);
        const page = pages[key] ?? { total_count: pages['']?.total_count, data: [] };
        return { ok: true, status: 200, json: async () => page, text: async () => '' } as any;
      }
      const m = u.pathname.match(/\/transcript\/([^/]+)\/access-link$/);
      if (m)
        return {
          ok: true,
          status: 200,
          json: async () => ({ link: `https://files.test/${m[1]}` }),
          text: async () => '',
        } as any;
      if (u.host === 'files.test')
        return { ok: true, status: 200, text: async () => vtt(`Speaker 0: ${u.pathname}`) } as any;
      throw new Error(`unexpected ${url}`);
    }) as any;
  };

  beforeEach(() => {
    process.env.DAILY_API_KEY = 'daily_test';
  });
  afterEach(() => {
    delete process.env.DAILY_API_KEY;
    jest.restoreAllMocks();
  });

  it('finds a transcript that is on a later page', async () => {
    daily({
      '': {
        total_count: 3,
        data: [
          { transcriptId: 'x', status: 't_finished', roomName: 'other' },
          { transcriptId: 'y', status: 't_finished', roomName: 'other' },
        ],
      },
      y: { total_count: 3, data: [{ transcriptId: 'a', status: 't_finished', roomName: 'r1' }] },
    });
    const got = await svc().transcriptFor('r1');
    expect(got).toEqual({ state: 'ready', text: 'Speaker 0: /a' });
    expect(listCalls).toEqual(['', 'y']);
  });

  it('stops, instead of looping, if the cursor brings back the same page', async () => {
    const same = {
      total_count: 50,
      data: [{ transcriptId: 'x', status: 't_finished', roomName: 'other' }],
    };
    daily({ '': same, x: same });
    expect(await svc().transcriptFor('r1')).toEqual({ state: 'none' });
    expect(listCalls).toEqual(['', 'x']);
  });

  it('reads a bounded number of pages however many the account has', async () => {
    const pages: Record<string, any> = {};
    let prev = '';
    for (let i = 0; i < 30; i++) {
      pages[prev] = {
        total_count: 1000,
        data: [{ transcriptId: `t${i}`, status: 't_finished', roomName: 'other' }],
      };
      prev = `t${i}`;
    }
    daily(pages);
    expect(await svc().transcriptFor('r1')).toEqual({ state: 'none' });
    expect(listCalls.length).toBe(10);
  });

  it('a response without total_count is read as the single page it is', async () => {
    daily({ '': { data: [{ transcriptId: 'a', status: 't_finished', roomName: 'r1' }] } });
    expect(await svc().transcriptFor('r1')).toEqual({ state: 'ready', text: 'Speaker 0: /a' });
    expect(listCalls).toEqual(['']);
  });

  it('a page that cannot be read is "error" (retried), never "none"', async () => {
    daily({
      '': { total_count: 2, data: [{ transcriptId: 'x', status: 't_finished', roomName: 'o' }] },
    });
    const real = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (url: string, init: any) => {
      if (url.includes('starting_after')) throw new Error('reset');
      return real(url, init);
    }) as any;
    expect(await svc().transcriptFor('r1')).toEqual({ state: 'error' });
  });
});

// ── L8 — a booking is history once the class has begun ─────────────────────

describe('L8: a student cannot erase their booking after the class starts', () => {
  const booking = (session: Record<string, unknown>) => ({
    id: 'b1',
    session: { status: 'SCHEDULED', deletedAt: null, ...session },
  });

  it('releases the seat, as before, while the session is still ahead', async () => {
    const { service, prisma } = liveWorld({
      booking: booking({ startsAt: new Date(Date.now() + 3600_000) }),
    });
    expect(await service.cancel('u_student', 'ls1')).toEqual({ ok: true });
    expect(prisma.liveBooking.deleteMany).toHaveBeenCalledWith({ where: { id: 'b1' } });
  });

  it.each([
    [
      'the teacher has opened the room',
      { status: 'LIVE', startsAt: new Date(Date.now() + 5 * MIN) },
    ],
    ['the class has ended', { status: 'ENDED', startsAt: new Date(Date.now() - 2 * 3600_000) }],
    [
      'the scheduled time has passed',
      { status: 'SCHEDULED', startsAt: new Date(Date.now() - MIN) },
    ],
  ])('refuses once %s, and keeps the booking', async (_, s) => {
    const { service, prisma } = liveWorld({ booking: booking(s) });
    const err = await service.cancel('u_student', 'ls1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'CANCEL_WINDOW_CLOSED' });
    expect(prisma.liveBooking.deleteMany).not.toHaveBeenCalled();
  });

  it('a session the teacher cancelled keeps its bookings as the record of it', async () => {
    const { service, prisma } = liveWorld({
      booking: booking({ startsAt: new Date(Date.now() + 3600_000), deletedAt: new Date() }),
    });
    expect(await service.cancel('u_student', 'ls1')).toEqual({ ok: true });
    expect(prisma.liveBooking.deleteMany).not.toHaveBeenCalled();
  });

  it('cancelling a booking that does not exist is a no-op', async () => {
    const { service, prisma } = liveWorld({ booking: null });
    expect(await service.cancel('u_student', 'ls1')).toEqual({ ok: true });
    expect(prisma.liveBooking.deleteMany).not.toHaveBeenCalled();
  });
});

// ── L9 — cancelling a session tells the people who booked it ────────────────

describe('L9: a cancelled session is recorded, announced and closed', () => {
  const booked = [{ student: { userId: 'su1' } }, { student: { userId: 'su2' } }];

  it('stamps when and why, soft-deletes in the same write, and tells every booked student', async () => {
    const { service, prisma, notifications, realtime, writes } = liveWorld({
      booked,
      session: { status: 'SCHEDULED', startsAt: new Date(Date.now() + 86_400_000) },
    });
    const res = await service.remove(OWNER, 'ls1', 'u_owner', '  المدرس تعبان  ');
    expect(res).toMatchObject({ id: 'ls1', deleted: true, notified: 2 });
    expect(writes[0]).toEqual({
      cancelledAt: expect.any(Date),
      cancelReason: 'المدرس تعبان',
      deletedAt: expect.any(Date),
    });
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect((notifications.create.mock.calls[0] as any)[0]).toMatchObject({
      userId: 'su1',
      meta: { sessionId: 'ls1', cancelled: true },
    });
    expect((notifications.create.mock.calls[0] as any)[0].body).toContain('المدرس تعبان');
    expect(realtime.emitToUser).toHaveBeenCalledWith('su2', 'live:ended', {
      sessionId: 'ls1',
      cancelled: true,
    });
    // Nothing about a class that never ran is torn down.
    expect(prisma.liveAttendance.updateMany).not.toHaveBeenCalled();
  });

  it('writes the cancellation to the audit log', async () => {
    const { service, prisma } = liveWorld({
      booked,
      session: { status: 'SCHEDULED', startsAt: new Date(Date.now() + 86_400_000) },
    });
    await service.remove(OWNER, 'ls1', 'u_owner');
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'u_owner',
        action: 'live.cancel',
        entity: 'LiveSession',
        entityId: 'ls1',
        academyId: 'a1',
      }),
    });
  });

  it('closes a class that was running: attendance, room and everyone inside', async () => {
    const { service, prisma, daily, realtime, writes } = liveWorld({
      booked,
      session: { status: 'LIVE', startsAt: new Date(Date.now() - 10 * MIN) },
    });
    await service.remove(OWNER, 'ls1');
    expect(writes[0]).toMatchObject({ status: 'ENDED', endedAt: expect.any(Date) });
    expect(prisma.liveAttendance.updateMany).toHaveBeenCalled();
    expect(daily.deleteRoom).toHaveBeenCalledWith('darsly-ls1');
    expect(realtime.emitToLive).toHaveBeenCalledWith('ls1', 'live:ended', {
      sessionId: 'ls1',
      cancelled: true,
    });
  });

  it('removing a session that is already over notifies nobody', async () => {
    const { service, notifications } = liveWorld({
      booked,
      session: { status: 'ENDED', startsAt: new Date(Date.now() - 86_400_000) },
    });
    expect(await service.remove(OWNER, 'ls1')).toMatchObject({ notified: 0 });
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

// ── P6 — an admin can resolve a part-wallet payment by hand ─────────────────

describe('P6: a manual match compares the transfer with what the transfer had to cover', () => {
  const build = (event: number) => {
    const prisma: any = {
      paymentEvent: {
        findUnique: jest.fn(async () => ({ id: 'e1', status: 'UNMATCHED', amountCents: event })),
        update: jest.fn(async () => ({})),
      },
      payment: {
        findUnique: jest.fn(async () => ({
          id: 'p1',
          status: 'PENDING',
          amountCents: 10_000,
          walletCents: 4_000,
          settledAt: null,
        })),
      },
    };
    const manual = { systemVerify: jest.fn(async () => ({ ok: true })), settle: jest.fn() };
    const service = new PaymentMatchingService(prisma, manual as any, {} as any);
    return { service, manual, prisma };
  };

  it('accepts a 60 EGP transfer for a 100 EGP payment with 40 EGP reserved from the wallet', async () => {
    const { service, manual } = build(6_000);
    expect(await service.manualMatch('e1', 'p1', 'admin')).toEqual({ ok: true });
    expect(manual.systemVerify).toHaveBeenCalledWith('p1');
  });

  it('still refuses a transfer of the full total — the wallet part was not transferred', async () => {
    const { service, manual } = build(10_000);
    const err = await service.manualMatch('e1', 'p1', 'admin').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(manual.systemVerify).not.toHaveBeenCalled();
  });
});
