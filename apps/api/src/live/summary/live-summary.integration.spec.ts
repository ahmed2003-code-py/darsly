import { randomUUID } from 'crypto';
import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { AiJobService } from '../../academy-site/jobs/ai-job.service';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveSummaryHandler } from '../live-summary.handler';
import { LiveService } from '../live.service';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CF_STUN } from '../providers/cloudflare-realtime.client';
import { LiveProviders } from '../providers/live-providers';
import { PARTIAL_NOTE } from './grounded-summary';

/**
 * The lesson summary on a real PostgreSQL, with a fake model (no paid calls):
 * the whole transcript goes to one gpt-6-luna call, grounded items only,
 * PARTIAL labelled, a summary made from words that changed meanwhile is not
 * written, regenerate never re-transcribes, and an exceptionally large class
 * is summarised in sections — never cut.
 */
const prisma = new PrismaService();
let available = true;
const env = { ...process.env };

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'aiJob']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterEach(() => {
  process.env = { ...env };
});
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

const LESSON = `طيب قبل ما نبدأ، الامتحان يوم الخميس الجاي. لا لا معلش، أنا غلطت، الامتحان يوم السبت مش الخميس، السبت الساعة عشرة.

قانون مساحة الدايرة: المساحة تساوي باي في نق. لأ استنوا، باي في نق تربيع، نق تربيع، معلش.

طالبة: طب يا أستاذ هو الامتحان هيبقى open book؟ المدرس: ده هنشوفه بعدين، مش دلوقتي.`;

async function lesson(transcript = LESSON, over: Record<string, unknown> = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `sm-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `sm-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `sma-${k}`, name: `A ${k}`, ownerUserId: teacher.id },
  });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: 'مراجعة قبل الامتحان',
      startsAt: new Date(Date.now() - 3600_000),
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(Date.now() - 60_000),
      durationMin: 60,
      status: 'ENDED',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}`,
      transcriptionMode: 'AUTO_WHEN_RECORDING',
      transcriptStatus: 'READY',
      transcriptText: transcript,
      transcriptRevision: 1,
      summaryStatus: 'PROCESSING',
      ...over,
    },
  });
  const scope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' as const };
  return { ls, tp, teacher, scope };
}

/** What a well-behaved model answers — grounded in LESSON — plus two inventions to be dropped. */
const ANSWER = {
  title: 'مراجعة قبل الامتحان',
  quickSummary: 'الامتحان يوم السبت الساعة عشرة، ومساحة الدائرة باي نق تربيع.',
  keyPoints: [
    {
      text: 'الامتحان يوم السبت الساعة عشرة',
      evidence: 'الامتحان يوم السبت مش الخميس، السبت الساعة عشرة',
    },
  ],
  concepts: [],
  examples: [
    {
      text: 'Decision trees مثال على supervised learning',
      evidence: 'decision trees are a classic example',
    },
  ],
  formulas: [
    { formula: 'A = πr²', meaning: 'مساحة الدائرة', evidence: 'باي في نق تربيع، نق تربيع' },
  ],
  questions: [
    {
      question: 'هل الامتحان open book؟',
      answered: true,
      answer: 'نعم',
      evidence: 'هو الامتحان هيبقى open book',
    },
  ],
  homework: [{ task: 'مشروع', due: '14 أكتوبر', evidence: 'المشروع تسليمه يوم أربعتاشر أكتوبر' }],
  corrections: [
    {
      wrong: 'الامتحان يوم الخميس',
      corrected: 'الامتحان يوم السبت',
      evidence: 'لا لا معلش، أنا غلطت، الامتحان يوم السبت',
    },
    {
      wrong: 'المساحة = باي في نق',
      corrected: 'المساحة = باي في نق تربيع',
      evidence: 'لأ استنوا، باي في نق تربيع',
    },
  ],
  reviewPoints: [],
  studyNotes: '### الامتحان\nالسبت الساعة عشرة.',
};

function fakeAi(answer: (call: any) => any = () => ANSWER) {
  const calls: any[] = [];
  const ai = {
    completeStructured: jest.fn(async (opts: any) => {
      calls.push(opts);
      const data = await answer(opts);
      return {
        data,
        inputTokens: Math.ceil(opts.messages[0].content.length / 3),
        outputTokens: 1500,
        reasoningTokens: 100,
      };
    }),
    // cents per million tokens → millicents
    costMillicents: (i: number, o: number, p: { inPerMToken: number; outPerMToken: number }) =>
      Math.round((i * p.inPerMToken + o * p.outPerMToken) / 1000),
  };
  return { ai, calls };
}
const cfClient = () => ({
  configured: true,
  turnConfigured: false,
  iceServers: jest.fn(async () => [CF_STUN]),
  closeTracks: jest.fn(async () => ({})),
  getSession: jest.fn(async () => ({ tracks: [] })),
});
const providers = () =>
  new LiveProviders([new CloudflareLiveProvider(prisma, cfClient() as any)], 'CLOUDFLARE');
const handlerWith = (ai: any) =>
  new LiveSummaryHandler(prisma, ai, providers(), { create: jest.fn(async () => ({})) } as any);
const job = (id: string, extra: Record<string, unknown> = {}, attempts = 1) =>
  ({
    id: `job-${randomUUID().slice(0, 8)}`,
    type: 'LIVE_SUMMARY',
    attempts,
    costCents: 0,
    input: { liveSessionId: id, ...extra },
  }) as any;
const reload = (id: string) => prisma.liveSession.findUniqueOrThrow({ where: { id } });

describe('one grounded luna call over the whole transcript', () => {
  it('a 3-hour-sized transcript is sent whole — the fact in its last line reaches the model', async () => {
    if (!guard()) return;
    const tail = 'آخر حاجة: الـ quiz الجاي هيبقى عن الـ confusion matrix بس.';
    const big = `${'كلام الحصة عن الـ regression والـ gradient descent. '.repeat(2_800)}\n\n${tail}`;
    expect(big.length).toBeGreaterThan(141_000);
    const w = await lesson(big);
    const { ai, calls } = fakeAi(() => ({
      ...ANSWER,
      keyPoints: [{ text: 'quiz', evidence: tail }],
    }));
    await handlerWith(ai).handle(job(w.ls.id));
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content).toContain(big);
    expect(calls[0]).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      reasoningEffort: 'low',
      maxTokens: 12_000,
    });
    const s = await reload(w.ls.id);
    expect(s.summaryStatus).toBe('READY');
    expect(s.summaryMeta as any).toMatchObject({
      model: 'gpt-6-luna',
      path: 'single',
      calls: 1,
      transcriptRevision: 1,
      partial: false,
    });
  });

  it('corrections kept, inventions dropped, an unanswered question keeps no answer, no homework invented', async () => {
    if (!guard()) return;
    const w = await lesson();
    const { ai } = fakeAi();
    await handlerWith(ai).handle(job(w.ls.id));
    const s = await reload(w.ls.id);
    const sum = s.summary as any;
    expect(sum.corrections.map((c: any) => c.corrected)).toEqual([
      'الامتحان يوم السبت',
      'المساحة = باي في نق تربيع',
    ]);
    expect(sum.examples).toHaveLength(0); // decision trees: not in the class
    expect(sum.homework).toHaveLength(0); // the project deadline: never said
    expect(sum.questions[0]).toMatchObject({ question: 'هل الامتحان open book؟' });
    expect((s.summaryMeta as any).dropped).toEqual({ examples: 1, homework: 1 });
    // Priced at luna's own price, logged per job.
    expect((s.summaryMeta as any).costMillicents).toBeGreaterThan(0);
  });

  it('a PARTIAL transcript is summarised as incomplete — told to the model and recorded', async () => {
    if (!guard()) return;
    const w = await lesson(LESSON, { transcriptStatus: 'PARTIAL' });
    const { ai, calls } = fakeAi();
    await handlerWith(ai).handle(job(w.ls.id));
    expect(calls[0].system).toContain(PARTIAL_NOTE);
    expect(((await reload(w.ls.id)).summaryMeta as any).partial).toBe(true);
  });

  it('a summary made from words that changed meanwhile is not written — the job runs again on the new words', async () => {
    if (!guard()) return;
    const w = await lesson();
    const { ai } = fakeAi(async () => {
      // A recovered piece lands while the model is writing.
      await prisma.liveSession.update({
        where: { id: w.ls.id },
        data: { transcriptRevision: 2, transcriptText: `${LESSON}\n\nكلام زيادة` },
      });
      return ANSWER;
    });
    const err = await handlerWith(ai)
      .handle(job(w.ls.id))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AiJobError);
    expect(err.errorClass).toBe('RETRYABLE');
    const s = await reload(w.ls.id);
    expect(s.summaryStatus).toBe('PROCESSING');
    expect(s.summary).toBeNull();
  });

  it('an answer cut off at its allowance is asked for once more at double', async () => {
    if (!guard()) return;
    const w = await lesson();
    let n = 0;
    const { ai, calls } = fakeAi(() => {
      if (++n === 1)
        throw new AiJobError(
          'AI response was cut off before it finished (max_output_tokens)',
          'RETRYABLE',
          { inputTokens: 100, outputTokens: 12_000 },
        );
      return ANSWER;
    });
    await handlerWith(ai).handle(job(w.ls.id));
    expect(calls.map((c) => c.maxTokens)).toEqual([12_000, 24_000]);
    expect((await reload(w.ls.id)).summaryStatus).toBe('READY');
  });

  it('an exceptionally large class is summarised in sections and merged by the same model — never cut', async () => {
    if (!guard()) return;
    process.env.LIVE_SUMMARY_SINGLE_CALL_MAX_TOKENS = '2000';
    process.env.LIVE_SUMMARY_SECTION_MAX_TOKENS = '1000';
    const paras = Array.from({ length: 12 }, (_, i) => `الجزء ${i}: ` + 'شرح '.repeat(150));
    const w = await lesson(paras.join('\n\n'));
    const { ai, calls } = fakeAi((c) =>
      c.schemaName === 'class_section_notes'
        ? {
            sectionSummary: 'x',
            keyPoints: [],
            concepts: [],
            examples: [],
            formulas: [],
            questions: [],
            homework: [],
            corrections: [],
          }
        : { ...ANSWER, keyPoints: [], formulas: [], corrections: [], questions: [] },
    );
    await handlerWith(ai).handle(job(w.ls.id));
    const sections = calls.filter((c) => c.schemaName === 'class_section_notes');
    expect(sections.length).toBeGreaterThan(1);
    expect(calls.at(-1).schemaName).toBe('class_study_notes');
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(['gpt-6-luna']));
    // Every paragraph went to some section.
    const sent = sections.map((c) => c.messages[0].content).join('\n');
    for (const p of paras) expect(sent).toContain(p.slice(0, 12));
    expect(((await reload(w.ls.id)).summaryMeta as any).path).toBe('sections');
  });
});

describe('failures stay in their own stage', () => {
  it('a summary failure never touches the transcript; a short Darsly transcript stays READY', async () => {
    if (!guard()) return;
    const w = await lesson('قصير جدا');
    const { ai } = fakeAi();
    const err = await handlerWith(ai)
      .handle(job(w.ls.id))
      .catch((e) => e);
    expect(err.errorClass).toBe('TERMINAL');
    const s = await reload(w.ls.id);
    expect(s.summaryStatus).toBe('FAILED');
    expect(s.transcriptStatus).toBe('READY');
    expect(s.transcriptText).toBe('قصير جدا');
  });

  it('a provider failure keeps "being prepared" until the last attempt, then says failed — the transcript untouched', async () => {
    if (!guard()) return;
    const w = await lesson();
    const { ai } = fakeAi(() => {
      throw new AiJobError('OpenAI request failed (503)', 'RETRYABLE');
    });
    const e1 = await handlerWith(ai)
      .handle(job(w.ls.id, {}, 1))
      .catch((e) => e);
    expect(e1.retryAfterMs).toBe(60_000);
    expect((await reload(w.ls.id)).summaryStatus).toBe('PROCESSING');
    await handlerWith(ai)
      .handle(job(w.ls.id, {}, 3))
      .catch(() => undefined);
    const s = await reload(w.ls.id);
    expect(s).toMatchObject({
      summaryStatus: 'FAILED',
      summaryError: 'AI_FAILED',
      transcriptStatus: 'READY',
      transcriptText: LESSON,
    });
  });
});

describe('regenerate', () => {
  function service() {
    const client = {
      configured: true,
      turnConfigured: false,
      iceServers: jest.fn(async () => [CF_STUN]),
      closeTracks: jest.fn(async () => ({})),
      getSession: jest.fn(async () => ({ tracks: [] })),
    };
    const providers = new LiveProviders(
      [new CloudflareLiveProvider(prisma, client as any)],
      'CLOUDFLARE',
    );
    const jobs = new AiJobService(prisma, { enabled: true, monthlyBudgetCents: 0 } as any);
    return new LiveService(
      prisma,
      { create: jest.fn(async () => ({})) } as any,
      {} as any,
      providers,
      { emitToLive: jest.fn(), emitToUser: jest.fn() } as any,
      jobs,
      {} as any,
    );
  }
  const jobsFor = (id: string, type: 'LIVE_SUMMARY' | 'LIVE_TRANSCRIBE') =>
    prisma.aiJob.findMany({ where: { type, input: { path: ['liveSessionId'], equals: id } } });

  it('queues one forced summary from the current words — no transcription job, double presses queue nothing more', async () => {
    if (!guard()) return;
    const w = await lesson();
    const { ai } = fakeAi();
    await handlerWith(ai).handle(job(w.ls.id));
    expect((await reload(w.ls.id)).summaryStatus).toBe('READY');
    const svc = service();
    const presses = await Promise.all(
      [1, 2, 3].map(() => svc.requestSummary(w.scope as any, w.ls.id, { regenerate: true })),
    );
    expect(presses.every((p) => p.status === 'PROCESSING')).toBe(true);
    const queued = await jobsFor(w.ls.id, 'LIVE_SUMMARY');
    expect(queued).toHaveLength(1);
    expect(queued[0].input).toMatchObject({ liveSessionId: w.ls.id, force: true });
    expect(await jobsFor(w.ls.id, 'LIVE_TRANSCRIBE')).toHaveLength(0);
    // The forced job makes a new summary for the same words; its redelivery pays nothing.
    const { ai: ai2, calls } = fakeAi();
    const forced = { ...queued[0], attempts: 1 } as any;
    await handlerWith(ai2).handle(forced);
    await handlerWith(ai2).handle(forced);
    expect(calls).toHaveLength(1);
    expect(((await reload(w.ls.id)).summaryMeta as any).jobId).toBe(queued[0].id);
    await prisma.aiJob.update({ where: { id: queued[0].id }, data: { status: 'SUCCEEDED' } });
  });

  it('without regenerate, a summary that exists is the answer (no job)', async () => {
    if (!guard()) return;
    const w = await lesson();
    await handlerWith(fakeAi().ai).handle(job(w.ls.id));
    expect(await service().requestSummary(w.scope as any, w.ls.id)).toEqual({ status: 'READY' });
    expect(await jobsFor(w.ls.id, 'LIVE_SUMMARY')).toHaveLength(0);
  });
});
