import { randomUUID } from 'crypto';
import { AcademySiteConfig } from '../academy-site/academy-site.config';
import { AiClient } from '../academy-site/ai/ai.client';
import { AiJobService } from '../academy-site/jobs/ai-job.service';
import { AiJobWorker } from '../academy-site/jobs/ai-job.worker';
import { LedgerService } from '../payments/ledger.service';
import { ManualPaymentsService } from '../payments/manual-payments.service';
import { PaymentMatchingService } from '../payments/payment-matching.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiveSummaryHandler } from './live-summary.handler';
import { LiveScope, LiveService, SUMMARY_STALE_MS } from './live.service';

/**
 * Checkpoint A against a real PostgreSQL.
 *
 * The unit specs (live-hardening.spec.ts) prove the logic against mocks. What
 * a mock cannot prove is what these do: that two UPDATEs racing on one row
 * really let only one through, that a JSON-path filter on AiJob.input really
 * scopes a clash to one lesson, that a cancelled session's bookings really are
 * still in the table, that the ledger really balances. Skipped when no
 * database is reachable at DATABASE_URL, like every *.integration.spec here.
 */
const prisma = new PrismaService();
let available = true;
const academies: string[] = [];
const users: string[] = [];

const aiConfig = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    enabled: true,
    monthlyBudgetCents: 0,
    apiKey: 'test',
    model: 'gpt-6-luna',
    priceInPerMToken: 200, // cents per million tokens
    priceOutPerMToken: 1000,
    workerEnabled: false,
    workerConcurrency: 1,
    ...over,
  }) as unknown as AcademySiteConfig;

const stubs = () => ({
  notifications: { create: jest.fn(async () => ({})) },
  daily: { closeRoom: jest.fn(async () => 'deleted'), recording: jest.fn(async () => null) },
  realtime: { emitToLive: jest.fn(), emitToUser: jest.fn() },
});

function liveService(jobs: AiJobService, s = stubs()) {
  return new LiveService(
    prisma,
    s.notifications as any,
    {} as any,
    s.daily as any,
    s.realtime as any,
    jobs,
    {} as any,
  );
}

/** A teacher with a personal academy, a student, and one session. */
async function world(session: Record<string, unknown> = {}, opts: { centerId?: string } = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `t-${k}@it.test` },
  });
  const student = await prisma.user.create({
    data: { role: 'STUDENT', fullName: `S ${k}`, email: `s-${k}@it.test` },
  });
  users.push(teacher.id, student.id);
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `t-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `a-${k}`, name: `A ${k}`, ownerUserId: teacher.id, feeValue: 0 },
  });
  academies.push(tp.id);
  let academyId = tp.id;
  if (opts.centerId) {
    await prisma.academy.create({
      data: {
        id: opts.centerId,
        slug: `c-${k}`,
        name: `C ${k}`,
        kind: 'CENTER',
        ownerUserId: teacher.id,
      },
    });
    academies.push(opts.centerId);
    academyId = opts.centerId;
  }
  const sp = await prisma.studentProfile.create({ data: { userId: student.id } });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() - 2 * 3600_000),
      durationMin: 60,
      status: 'ENDED',
      roomName: `darsly-it-${k}`,
      ...session,
    },
  });
  const scope: LiveScope = { academyId, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { k, teacher, student, tp, sp, ls, scope, academyId };
}

const summaryJobs = (liveSessionId: string) =>
  prisma.aiJob.findMany({
    where: { type: 'LIVE_SUMMARY', input: { path: ['liveSessionId'], equals: liveSessionId } },
  });

/** Nothing this file queued may be left for the next test's claimNext. */
async function parkJobs() {
  await prisma.aiJob.updateMany({
    where: { academyId: { in: academies }, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELED' },
  });
}

beforeAll(async () => {
  try {
    await prisma.onModuleInit();
    await prisma.liveSession.count();
  } catch {
    available = false;
  }
});
afterEach(async () => {
  if (available) await parkJobs();
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

// ── L1 / L2 ──────────────────────────────────────────────────────────────────

describe('L1 on Postgres: summary requests', () => {
  it('five simultaneous presses create exactly one LIVE_SUMMARY job', async () => {
    if (!guard()) return;
    const w = await world();
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => svc.requestSummary(w.scope, w.ls.id)),
    );
    expect(results.every((r) => r.status === 'PROCESSING')).toBe(true);
    expect(await summaryJobs(w.ls.id)).toHaveLength(1);
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.summaryStatus).toBe('PROCESSING');
  });

  it('AI disabled: nothing queued, the lesson stays NOT_STARTED, and the next press works', async () => {
    if (!guard()) return;
    const w = await world();
    const off = liveService(new AiJobService(prisma, aiConfig({ enabled: false })));
    const err = await off.requestSummary(w.scope, w.ls.id).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AI_DISABLED' });
    expect(
      (await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } })).summaryStatus,
    ).toBe('NOT_STARTED');
    expect(await summaryJobs(w.ls.id)).toHaveLength(0);

    const on = liveService(new AiJobService(prisma, aiConfig()));
    expect(await on.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    expect(await summaryJobs(w.ls.id)).toHaveLength(1);
  });

  it('budget reached: refused with its code, and the earlier failure is kept', async () => {
    if (!guard()) return;
    const w = await world({ summaryStatus: 'FAILED', summaryError: 'TRANSCRIPT_PENDING' });
    // Any spend this month is over a 1¢ budget.
    await prisma.aiJob.create({
      data: { academyId: w.academyId, type: 'SITE_GENERATE', status: 'SUCCEEDED', costCents: 5 },
    });
    const svc = liveService(new AiJobService(prisma, aiConfig({ monthlyBudgetCents: 1 })));
    const err = await svc.requestSummary(w.scope, w.ls.id).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AI_BUDGET_REACHED' });
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.summaryStatus).toBe('FAILED');
    expect(row.summaryError).toBe('TRANSCRIPT_PENDING');
  });

  it('an unrelated AI job in the same academy does not block the summary', async () => {
    if (!guard()) return;
    const w = await world();
    await prisma.aiJob.create({
      data: { academyId: w.academyId, type: 'SITE_GENERATE', status: 'RUNNING' },
    });
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    expect(await svc.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    expect(await summaryJobs(w.ls.id)).toHaveLength(1);
  });

  it("an active job for the SAME lesson blocks a duplicate; another lesson's does not", async () => {
    if (!guard()) return;
    const w = await world({ summaryStatus: 'FAILED', summaryError: 'AI_FAILED' });
    await prisma.aiJob.create({
      data: {
        academyId: w.academyId,
        type: 'LIVE_SUMMARY',
        status: 'QUEUED',
        input: { liveSessionId: w.ls.id },
      },
    });
    const jobs = new AiJobService(prisma, aiConfig());
    const svc = liveService(jobs);
    expect(await svc.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    expect(await summaryJobs(w.ls.id)).toHaveLength(1);

    // The JSON-path filter is what scopes the clash: a second lesson in the
    // same academy is not held up by the first one's job.
    const other = await prisma.liveSession.create({
      data: {
        tenantId: w.tp.id,
        academyId: w.academyId,
        title: 'أخرى',
        startsAt: new Date(Date.now() - 3600_000),
        status: 'ENDED',
      },
    });
    expect(await svc.requestSummary(w.scope, other.id)).toEqual({ status: 'PROCESSING' });
    expect(await summaryJobs(other.id)).toHaveLength(1);

    // …and a direct enqueue for the first lesson is refused by the queue itself.
    const err = await jobs
      .enqueue(
        w.academyId,
        'LIVE_SUMMARY',
        { liveSessionId: w.ls.id },
        { sameInput: { path: 'liveSessionId', equals: w.ls.id } },
      )
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AI_JOB_ACTIVE' });
  });

  it('a PROCESSING stranded with a dead job reads as STALLED and can be asked again', async () => {
    if (!guard()) return;
    const w = await world({ summaryStatus: 'PROCESSING' });
    await prisma.aiJob.create({
      data: {
        academyId: w.academyId,
        type: 'LIVE_SUMMARY',
        status: 'FAILED',
        input: { liveSessionId: w.ls.id },
      },
    });
    // @updatedAt is set by Prisma on every write; age the row the way time would.
    // In UTC, as Prisma writes it: a JS Date bound into raw SQL is converted to
    // the session's zone (see AiJobService.claimNext), which on a non-UTC
    // database would age it into the future instead.
    const staleSeconds = Math.ceil((SUMMARY_STALE_MS + 60_000) / 1000);
    await prisma.$executeRaw`UPDATE "LiveSession"
      SET "updatedAt" = (now() AT TIME ZONE 'UTC') - make_interval(secs => ${staleSeconds})
      WHERE id = ${w.ls.id}`;
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    const d = await svc.sessionDetail(w.teacher.id, w.ls.id);
    expect(d.summary.status).toBe('FAILED');
    expect((d.summary as any).error).toBe('STALLED');

    expect(await svc.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    const active = (await summaryJobs(w.ls.id)).filter((j) => j.status === 'QUEUED');
    expect(active).toHaveLength(1);
  });

  it('L2: a Center lesson queues its job on the Center', async () => {
    if (!guard()) return;
    const centerId = `center-${randomUUID().slice(0, 8)}`;
    const w = await world({}, { centerId });
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    await svc.requestSummary(w.scope, w.ls.id);
    const [job] = await summaryJobs(w.ls.id);
    expect(job.academyId).toBe(centerId);
    expect(job.academyId).not.toBe(w.tp.id);
  });
});

// ── L3 — one summary, end to end, through the real worker, with a retry ─────

describe('L3 on Postgres: AI call → AiCallLog → AiJob → monthly budget', () => {
  it('attempt 1 is billed and fails, attempt 2 succeeds: the job carries both, once', async () => {
    if (!guard()) return;
    await parkJobs();
    // Any QUEUED job anywhere would be claimed first; this test owns the queue.
    await prisma.aiJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELED' },
    });
    const w = await world({ transcriptText: 'المدرس: '.padEnd(400, 'ا') });
    const config = aiConfig();
    const jobs = new AiJobService(prisma, config);
    const svc = liveService(jobs);
    await svc.requestSummary(w.scope, w.ls.id);

    const create = jest
      .fn()
      // Attempt 1: cut off at the token ceiling — rejected, but billed.
      .mockResolvedValueOnce({
        id: 'resp_cut',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: '{"summary":',
        usage: { input_tokens: 1000, output_tokens: 6000 },
      })
      // Attempt 2: a good answer.
      .mockResolvedValueOnce({
        id: 'resp_ok',
        status: 'completed',
        output_text: JSON.stringify({
          summary: 'ملخص',
          topics: [],
          keyPoints: [],
          questionsAndAnswers: [],
          actionItems: [],
        }),
        usage: { input_tokens: 5000, output_tokens: 3000 },
      });
    const ai = new AiClient(config, prisma);
    (ai as any).client = { responses: { create } };
    const handler = new LiveSummaryHandler(
      prisma,
      ai,
      { transcriptFor: jest.fn(), transcriptionAvailable: jest.fn() } as any,
      { create: jest.fn(async () => ({})) } as any,
    );
    const worker = new AiJobWorker(config, jobs, [handler]);
    const runOnce = async () => {
      const job = await jobs.claimNext(60_000);
      expect(job?.type).toBe('LIVE_SUMMARY');
      await (worker as any).process(job);
      return job!.id;
    };
    const monthSpend = async () => {
      const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const agg = await prisma.aiJob.aggregate({
        _sum: { costCents: true },
        where: { createdAt: { gte: start } },
      });
      return agg._sum.costCents ?? 0;
    };
    const spendBefore = await monthSpend();

    const jobId = await runOnce();
    let job = await prisma.aiJob.findUniqueOrThrow({ where: { id: jobId } });
    // 1000×200/M + 6000×1000/M = 0.2 + 6 = 6.2¢ → charged 7¢, and back in the queue.
    expect(job.status).toBe('QUEUED');
    expect(job.costCents).toBe(7);

    expect(await runOnce()).toBe(jobId);
    job = await prisma.aiJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('SUCCEEDED');

    // The two calls, as logged — wait for the background writes to land.
    let calls: any[] = [];
    for (let i = 0; i < 50 && calls.length < 2; i++) {
      calls = await prisma.aiCallLog.findMany({
        where: { aiJobId: jobId },
        orderBy: { startedAt: 'asc' },
      });
      if (calls.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls.map((c) => [c.status, c.costMillicents])).toEqual([
      ['incomplete', 6200],
      ['ok', 4000],
    ]);
    expect(calls.every((c) => c.liveSessionId === w.ls.id && c.stage === 'LIVE_SUMMARY')).toBe(
      true,
    );

    // The job's cost is the sum of its calls — attempt 1 not lost, nothing twice.
    const logged = calls.reduce((n, c) => n + c.costMillicents, 0);
    expect(logged).toBe(10_200);
    expect(job.costCents).toBe(Math.ceil(logged / 1000)); // 11¢

    // …and the month's budget grew by exactly that, once.
    expect((await monthSpend()) - spendBefore).toBe(job.costCents);

    // The lesson is readable by session: its calls, and its job.
    expect(await prisma.aiCallLog.count({ where: { liveSessionId: w.ls.id } })).toBe(2);
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.summaryStatus).toBe('READY');
    expect(job.academyId).toBe(w.academyId);
  });
});

describe('L1 on Postgres: a worker that fails every attempt', () => {
  it('leaves the lesson FAILED (never PROCESSING) and a new press queues a new job', async () => {
    if (!guard()) return;
    await prisma.aiJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELED' },
    });
    const w = await world({ transcriptText: 'المدرس: '.padEnd(400, 'ا') });
    const config = aiConfig();
    const jobs = new AiJobService(prisma, config);
    const svc = liveService(jobs);
    await svc.requestSummary(w.scope, w.ls.id);

    const ai = new AiClient(config, prisma);
    // The provider is down for every attempt: no response, nothing billed.
    (ai as any).client = {
      responses: { create: jest.fn().mockRejectedValue(new Error('upstream 503')) },
    };
    const handler = new LiveSummaryHandler(
      prisma,
      ai,
      { transcriptFor: jest.fn(), transcriptionAvailable: jest.fn() } as any,
      { create: jest.fn(async () => ({})) } as any,
    );
    const worker = new AiJobWorker(config, jobs, [handler]);
    let jobId = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await jobs.claimNext(60_000);
      jobId = job!.id;
      await (worker as any).process(job);
    }
    const job = await prisma.aiJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(3);
    expect(job.costCents).toBe(0);
    const row = await prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
    expect(row.summaryStatus).toBe('FAILED');
    expect(row.summaryError).toBe('AI_FAILED');

    expect(await svc.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    expect((await summaryJobs(w.ls.id)).filter((j) => j.status === 'QUEUED')).toHaveLength(1);
  });

  it('a job whose worker died mid-run (lease expired) still counts as in flight', async () => {
    if (!guard()) return;
    const w = await world({ summaryStatus: 'PROCESSING' });
    await prisma.aiJob.create({
      data: {
        academyId: w.academyId,
        type: 'LIVE_SUMMARY',
        status: 'RUNNING',
        leaseExpiresAt: new Date(Date.now() - 60_000),
        input: { liveSessionId: w.ls.id },
      },
    });
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    // Another replica will re-claim it; a press must not queue a second one.
    expect(await svc.requestSummary(w.scope, w.ls.id)).toEqual({ status: 'PROCESSING' });
    expect(await summaryJobs(w.ls.id)).toHaveLength(1);
  });
});

// ── L8 / L9 — history survives ───────────────────────────────────────────────

describe('L8/L9 on Postgres: cancelling keeps the record', () => {
  it('a cancelled session keeps its bookings and attendance, and records why', async () => {
    if (!guard()) return;
    const w = await world({ status: 'LIVE', startsAt: new Date(Date.now() - 10 * 60_000) });
    await prisma.liveBooking.create({ data: { sessionId: w.ls.id, studentId: w.sp.id } });
    await prisma.liveAttendance.create({
      data: { sessionId: w.ls.id, userId: w.student.id, role: 'STUDENT', durationSeconds: 300 },
    });
    const s = stubs();
    const svc = liveService(new AiJobService(prisma, aiConfig()), s);

    const res = await svc.remove(w.scope, w.ls.id, w.teacher.id, 'ظرف طارئ');
    expect(res.notified).toBe(1);

    const raw = await prisma.$queryRaw<any[]>`
      SELECT "deletedAt", "cancelledAt", "cancelReason", status FROM "LiveSession" WHERE id = ${w.ls.id}`;
    expect(raw[0]).toMatchObject({ cancelReason: 'ظرف طارئ', status: 'ENDED' });
    expect(raw[0].deletedAt).toBeInstanceOf(Date);
    expect(raw[0].cancelledAt).toBeInstanceOf(Date);
    // Hidden from every ordinary read…
    expect(await prisma.liveSession.findFirst({ where: { id: w.ls.id } })).toBeNull();
    // …while the booking and the attendance are still there, attendance closed.
    expect(await prisma.liveBooking.count({ where: { sessionId: w.ls.id } })).toBe(1);
    const att = await prisma.liveAttendance.findFirstOrThrow({ where: { sessionId: w.ls.id } });
    expect(att.durationSeconds).toBe(300);
    expect(att.leftAt).toBeInstanceOf(Date);
    expect(s.daily.closeRoom).toHaveBeenCalledWith(w.ls.roomName);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'LiveSession', entityId: w.ls.id, action: 'live.cancel' },
    });
    expect(audit.academyId).toBe(w.academyId);
  });

  it('a student cannot delete their booking once the class is live', async () => {
    if (!guard()) return;
    const w = await world({ status: 'LIVE', startsAt: new Date(Date.now() + 5 * 60_000) });
    await prisma.liveBooking.create({ data: { sessionId: w.ls.id, studentId: w.sp.id } });
    const svc = liveService(new AiJobService(prisma, aiConfig()));
    const err = await svc.cancel(w.student.id, w.ls.id).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'CANCEL_WINDOW_CLOSED' });
    expect(await prisma.liveBooking.count({ where: { sessionId: w.ls.id } })).toBe(1);
  });
});

// ── P6 — a part-wallet payment matched by hand, through the real ledger ─────

describe('P6 on Postgres: manual match of a wallet + transfer payment', () => {
  it('matches the 60 EGP transfer to a 100 EGP payment with 40 EGP from the wallet', async () => {
    if (!guard()) return;
    const w = await world();
    const ledger = new LedgerService(prisma);
    const manual = new ManualPaymentsService(
      prisma,
      ledger,
      { create: jest.fn(async () => ({})) } as any,
      {} as any,
      {} as any,
    );
    const matching = new PaymentMatchingService(prisma, manual, {} as any);
    const course = await prisma.course.create({
      data: {
        tenantId: w.tp.id,
        academyId: w.tp.id,
        title: 'كورس',
        status: 'PUBLISHED',
        priceCents: 10_000,
      },
    });
    const enrollment = await prisma.enrollment.create({
      data: {
        studentId: w.sp.id,
        courseId: course.id,
        tenantId: w.tp.id,
        academyId: w.tp.id,
        status: 'PENDING_PAYMENT',
      },
    });
    const payment = await prisma.payment.create({
      data: {
        studentId: w.sp.id,
        courseId: course.id,
        enrollmentId: enrollment.id,
        tenantId: w.tp.id,
        academyId: w.tp.id,
        amountCents: 10_000,
        walletCents: 4_000,
        feeCents: 0,
        netCents: 10_000,
        method: 'INSTAPAY',
        reference: `ref-${w.k}`,
        status: 'PENDING',
      },
    });
    // The student's 40 EGP: topped up, then reserved for this payment at submit.
    await ledger.creditWallet(w.sp.id, 4_000, 'topup', prisma);
    await ledger.reserveWalletPortion(w.sp.id, payment.id, 4_000, prisma);
    const event = await prisma.paymentEvent.create({
      data: {
        provider: 'INSTAPAY',
        amountCents: 6_000,
        occurredAt: new Date(),
        status: 'UNMATCHED',
      },
    });

    expect(await matching.manualMatch(event.id, payment.id, 'admin')).toEqual({ ok: true });

    const paid = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { ledgerTransaction: { include: { entries: true } } },
    });
    expect(paid.status).toBe('PAID');
    expect(paid.settledAt).toBeInstanceOf(Date);
    const entries = paid.ledgerTransaction!.entries;
    const sum = (dir: string) =>
      entries.filter((e) => e.direction === dir).reduce((n, e) => n + e.amountCents, 0);
    expect(sum('DEBIT')).toBe(sum('CREDIT'));
    // 60 from the transfer, 40 out of this payment's escrow — never 100 of new cash.
    expect(entries.find((e) => e.account === 'platform:cash')?.amountCents).toBe(6_000);
    expect(
      entries.find((e) => e.account === `payment:${payment.id}:wallet-hold`)?.amountCents,
    ).toBe(4_000);
    expect(
      (await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status,
    ).toBe('ACTIVE');
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'MATCHED',
    );

    // A transfer of the full 100 is not what this payment was waiting for.
    const other = await prisma.paymentEvent.create({
      data: { provider: 'INSTAPAY', amountCents: 10_000, occurredAt: new Date() },
    });
    const err = await matching.manualMatch(other.id, payment.id, 'admin').catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'AMOUNT_MISMATCH' });
  });
});
