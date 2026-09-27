import { randomUUID } from 'crypto';
import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { AiJobService } from '../../academy-site/jobs/ai-job.service';
import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { pipelineStages } from '../live-pipeline';
import { LiveService } from '../live.service';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CF_STUN } from '../providers/cloudflare-realtime.client';
import { LiveProviders } from '../providers/live-providers';
import { LiveRetentionService } from '../retention/live-retention.service';
import { LiveTranscribeHandler, TRANSCRIPT_LEASE_MS } from './live-transcribe.handler';
import { audioKey } from './lesson-transcription';

/**
 * The LIVE_TRANSCRIBE pipeline on a real PostgreSQL — the regressions for the
 * 2026-09-27 audit: a transcript is never READY with pieces missing, failed
 * audio is kept for a retry, a provider outage is retried later instead of
 * giving the lesson up, one owner per class, late pieces are never dropped,
 * nothing stays PROCESSING for ever. The speech-to-text call is a fake (it is
 * a paid call); storage is in memory.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;
const PIECE_SEC = 180;
const env = { ...process.env };

beforeAll(async () => {
  available = await databaseReady(prisma, ['liveSession', 'liveAudioSegment']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
beforeEach(() => {
  process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
});
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

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put: async (key: string, buf: Buffer) => void objects.set(key, buf),
    getBuffer: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw new Error(`NoSuchKey ${key}`);
      return b;
    },
    delete: async (key: string) => void objects.delete(key),
    deletePrefix: async (prefix: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    },
  };
}
type Storage = ReturnType<typeof memoryStorage>;

/** An ended class with `pieces` three-minute pieces, inserted in a scrambled order. */
async function world(pieces: number, opts: { durations?: Record<number, number>; title?: string } = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({ data: { role: 'TEACHER', fullName: `T ${k}`, email: `tr-${k}@it.test` } });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `tr-${k}` } });
  await prisma.academy.create({ data: { id: tp.id, slug: `tra-${k}`, name: `A ${k}`, ownerUserId: teacher.id } });
  const startSec = Math.floor(Date.now() / 1000) - pieces * PIECE_SEC - 600;
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: opts.title ?? `Machine Learning ${k}`,
      startsAt: new Date(startSec * 1000),
      startedAt: new Date(startSec * 1000),
      endedAt: new Date(Date.now() - 10 * MIN),
      durationMin: Math.max(1, Math.ceil((pieces * PIECE_SEC) / 60)),
      status: 'ENDED',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}`,
      transcriptionMode: 'AUTO_WHEN_RECORDING',
      transcriptStatus: 'PROCESSING',
    },
  });
  const storage = memoryStorage();
  const order = Array.from({ length: pieces }, (_, i) => i).sort((a, b) => ((a * 7919) % pieces) - ((b * 7919) % pieces));
  for (const n of order) await addPiece(ls, storage, startSec + n * PIECE_SEC, opts.durations?.[n]);
  const scope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' as const };
  return { ls, storage, startSec, roomName: ls.roomName!, tp, teacher, scope };
}
async function addPiece(ls: { id: string; roomName: string | null }, storage: Storage, seq: number, durationSec = PIECE_SEC) {
  const key = audioKey(ls.id, ls.roomName!, seq);
  await storage.put(key, Buffer.from(`audio:${seq}`));
  return prisma.liveAudioSegment.create({
    data: { sessionId: ls.id, roomName: ls.roomName!, seq, key, sizeBytes: 720_000, durationMs: durationSec * 1000 },
  });
}
const seqOf = (audio: Buffer) => Number(audio.toString().split(':')[1]);
const idx = (w: { startSec: number }, audio: Buffer) => (seqOf(audio) - w.startSec) / PIECE_SEC;
const words = (w: { startSec: number }) => (audio: Buffer) => `مقطع ${idx(w, audio)} — supervised learning`;
const job = (liveSessionId: string, roomName: string, attempts = 1) =>
  ({ id: `job-${randomUUID().slice(0, 8)}`, type: 'LIVE_TRANSCRIBE', attempts, input: { liveSessionId, roomName } }) as any;
const noSleep = async () => undefined;
const reload = (id: string) => prisma.liveSession.findUniqueOrThrow({ where: { id } });
const paragraphs = (t: string | null) => (t ?? '').split('\n\n').filter(Boolean);
const rows = (sessionId: string) => prisma.liveAudioSegment.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
const handler = (w: { storage: Storage }, stt: any, onChanged?: any) =>
  new LiveTranscribeHandler(prisma, w.storage as any, stt, noSleep, onChanged);

describe('long classes: every piece once, in order', () => {
  for (const [label, n] of [['1 piece', 1], ['1 hour', 20], ['3 hours', 60]] as const) {
    it(`${label}: READY, chronological, audio deleted only after each piece's words are saved`, async () => {
      if (!guard()) return;
      const w = await world(n);
      const stt = jest.fn(async (a: Buffer) => words(w)(a));
      const changed = jest.fn(async () => undefined);
      await handler(w, stt, changed).handle(job(w.ls.id, w.roomName));
      const s = await reload(w.ls.id);
      expect(s.transcriptStatus).toBe('READY');
      expect(stt).toHaveBeenCalledTimes(n);
      expect(paragraphs(s.transcriptText)).toEqual(Array.from({ length: n }, (_, i) => `مقطع ${i} — supervised learning`));
      expect(w.storage.objects.size).toBe(0);
      const r = await rows(w.ls.id);
      expect(r.every((p) => p.text && p.audioDeletedAt)).toBe(true);
      expect(s.transcriptRevision).toBe(1);
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: w.ls.id, status: 'READY', revision: 1 }));
    }, 120_000);
  }
});

describe('permanent failures: PARTIAL, never READY, failed audio kept', () => {
  for (const where of ['first', 'middle', 'last'] as const) {
    it(`${where} piece refused for good → PARTIAL; its audio is kept, the rest deleted`, async () => {
      if (!guard()) return;
      const w = await world(5);
      const bad = { first: 0, middle: 2, last: 4 }[where];
      const stt = jest.fn(async (a: Buffer) => {
        if (idx(w, a) === bad) throw new AiJobError('Transcription refused (400): bad audio', 'TERMINAL');
        return words(w)(a);
      });
      await handler(w, stt).handle(job(w.ls.id, w.roomName));
      const s = await reload(w.ls.id);
      expect(s.transcriptStatus).toBe('PARTIAL');
      expect((s.transcriptMeta as any)).toMatchObject({ partial: true, failed: 1, pieces: 5 });
      expect(paragraphs(s.transcriptText)).toHaveLength(4);
      const failed = (await rows(w.ls.id)).find((p) => p.error)!;
      expect(w.storage.objects.has(failed.key)).toBe(true);
      expect(w.storage.objects.size).toBe(1);
      const st = pipelineStages({ provider: 'CLOUDFLARE', transcriptStatus: s.transcriptStatus, hasTranscriptText: true, summaryStatus: 'NOT_STARTED', summaryError: null, recordingStage: null, transcriptionOn: true });
      expect(st.transcript.stage).toBe('PARTIAL');
      expect(st.summary.canGenerate).toBe(true);
    });
  }

  it('every piece refused → FAILED (not "no speech"), audio kept', async () => {
    if (!guard()) return;
    const w = await world(2);
    const stt = jest.fn(async () => {
      throw new AiJobError('Transcription refused (400)', 'TERMINAL');
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('FAILED');
    expect((s.transcriptMeta as any).reason).toBe('ALL_FAILED');
    expect(w.storage.objects.size).toBe(2);
  });
});

describe('temporary outages: retried later, never given up early', () => {
  it('a 503 on piece 4 → the job asks to be retried in ≈1 min; what was saved stays; the next attempt finishes READY', async () => {
    if (!guard()) return;
    const w = await world(6);
    let down = true;
    const stt = jest.fn(async (a: Buffer) => {
      if (down && idx(w, a) >= 3) throw new AiJobError('Transcription refused (503)', 'RETRYABLE');
      return words(w)(a);
    });
    const h = handler(w, stt);
    const err = await h.handle(job(w.ls.id, w.roomName, 1)).catch((e) => e);
    expect(err).toBeInstanceOf(AiJobError);
    expect(err.errorClass).toBe('RETRYABLE');
    expect(err.retryAfterMs).toBe(60_000);
    let s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PROCESSING');
    expect((await rows(w.ls.id)).filter((p) => p.text).length).toBe(3);
    expect((await rows(w.ls.id)).some((p) => p.error)).toBe(false);
    down = false;
    await h.handle(job(w.ls.id, w.roomName, 2));
    s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(paragraphs(s.transcriptText)).toHaveLength(6);
    // Pieces 0–2 were never paid again.
    expect(stt.mock.calls.filter((c) => idx(w, c[0]) < 3)).toHaveLength(3);
  });

  it('the retry schedule is 1, 5, 15 minutes; only the 4th attempt gives up — and then PARTIAL, audio kept', async () => {
    if (!guard()) return;
    const w = await world(3);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 2) throw new AiJobError('Transcription unreachable: TimeoutError', 'RETRYABLE');
      return words(w)(a);
    });
    const h = handler(w, stt);
    const delays: number[] = [];
    for (const attempt of [1, 2, 3]) {
      const e = await h.handle(job(w.ls.id, w.roomName, attempt)).catch((x) => x);
      delays.push(e.retryAfterMs);
    }
    expect(delays).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
    await h.handle(job(w.ls.id, w.roomName, 4));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    const lost = (await rows(w.ls.id)).find((p) => p.error)!;
    expect(lost.error).toMatch(/^GAVE_UP/);
    expect(w.storage.objects.has(lost.key)).toBe(true);
  });

  it('the queue honours the delay: a delayed retry is not claimable before its time', async () => {
    if (!guard()) return;
    const jobs = new AiJobService(prisma, { enabled: true, monthlyBudgetCents: 0 } as any);
    const w = await world(1);
    const j = await prisma.aiJob.create({ data: { academyId: w.tp.id, type: 'LIVE_TRANSCRIBE', input: { liveSessionId: w.ls.id, roomName: w.roomName }, status: 'RUNNING', attempts: 1 } });
    await jobs.fail(j.id, { message: 'x', errorClass: 'RETRYABLE', retryAfterMs: 60_000 });
    const after = await prisma.aiJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(after.status).toBe('QUEUED');
    expect(after.runAfter!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Claiming now never returns it.
    for (let i = 0; i < 5; i++) {
      const c = await jobs.claimNext(60_000);
      if (!c) break;
      expect(c.id).not.toBe(j.id);
      await prisma.aiJob.update({ where: { id: c.id }, data: { status: 'SUCCEEDED' } });
    }
    await prisma.aiJob.update({ where: { id: j.id }, data: { runAfter: new Date(Date.now() - 1000) } });
    let got = null;
    for (let i = 0; i < 20 && !got; i++) {
      const c = await jobs.claimNext(60_000);
      if (!c) break;
      if (c.id === j.id) got = c;
      else await prisma.aiJob.update({ where: { id: c.id }, data: { status: 'SUCCEEDED' } });
    }
    expect(got?.id).toBe(j.id);
    // LIVE_TRANSCRIBE gets four attempts, then FAILED.
    await prisma.aiJob.update({ where: { id: j.id }, data: { status: 'RUNNING', attempts: 4 } });
    await jobs.fail(j.id, { message: 'x', errorClass: 'RETRYABLE', retryAfterMs: 60_000 });
    expect((await prisma.aiJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('FAILED');
  });
});

describe('workers, leases and duplicates', () => {
  it('crash AFTER the answer, BEFORE saving: that piece is paid twice, kept once', async () => {
    if (!guard()) return;
    const w = await world(3);
    let crashed = false;
    const stt = jest.fn(async (a: Buffer) => {
      if (!crashed && idx(w, a) === 1) {
        crashed = true;
        throw new Error('process killed');
      }
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1)).catch(() => undefined);
    // The dead worker's lease expires (it never released it).
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { transcriptLeaseUntil: new Date(Date.now() - 1000) } });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 2));
    expect(paragraphs((await reload(w.ls.id)).transcriptText)).toEqual([0, 1, 2].map((i) => `مقطع ${i} — supervised learning`));
    expect(stt).toHaveBeenCalledTimes(4);
  });

  it('crash AFTER saving: the retry never pays for the saved piece again', async () => {
    if (!guard()) return;
    const w = await world(3);
    let n = 0;
    const stt = jest.fn(async (a: Buffer) => {
      if (++n === 2) throw new Error('process killed after piece 0 was saved');
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1)).catch(() => undefined);
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 2));
    expect(stt.mock.calls.map((c) => idx(w, c[0]))).toEqual([0, 1, 1, 2]);
    expect((await reload(w.ls.id)).transcriptStatus).toBe('READY');
  });

  it('two workers on one class at once: one owner, no duplicate text, at most one extra paid call', async () => {
    if (!guard()) return;
    const w = await world(8);
    const stt = jest.fn(async (a: Buffer) => {
      await new Promise((r) => setTimeout(r, 15));
      return words(w)(a);
    });
    const r = await Promise.allSettled([
      handler(w, stt).handle(job(w.ls.id, w.roomName)),
      handler(w, stt).handle(job(w.ls.id, w.roomName)),
    ]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    const p = paragraphs((await reload(w.ls.id)).transcriptText);
    expect(p).toHaveLength(8);
    expect(new Set(p).size).toBe(8);
    expect(stt.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it('a stalled owner whose lease was taken over stops before paying for another piece', async () => {
    if (!guard()) return;
    const w = await world(4);
    let taken = false;
    const stt = jest.fn(async (a: Buffer) => {
      if (!taken && idx(w, a) === 1) {
        taken = true;
        // While the first worker hangs on this call, its lease runs out and another job claims the class.
        await prisma.liveSession.update({ where: { id: w.ls.id }, data: { transcriptLeaseJobId: 'other-job', transcriptLeaseUntil: new Date(Date.now() + TRANSCRIPT_LEASE_MS) } });
      }
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    expect(stt).toHaveBeenCalledTimes(2); // pieces 0 and 1 — not 2 and 3
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PROCESSING'); // the new owner decides it
  });

  it('the same job delivered again after it finished pays for nothing', async () => {
    if (!guard()) return;
    const w = await world(3);
    const stt = jest.fn(async (a: Buffer) => words(w)(a));
    const j = job(w.ls.id, w.roomName);
    await handler(w, stt).handle(j);
    await handler(w, stt).handle(j);
    expect(stt).toHaveBeenCalledTimes(3);
    expect((await reload(w.ls.id)).transcriptRevision).toBe(1);
  });

  it('a duplicate upload of the same piece is one row', async () => {
    if (!guard()) return;
    const w = await world(2);
    await expect(addPiece(w.ls, w.storage, w.startSec)).rejects.toThrow();
  });
});

describe('late pieces', () => {
  it('a piece that lands while the job runs is transcribed in the same job', async () => {
    if (!guard()) return;
    const w = await world(4);
    let injected = false;
    const stt = jest.fn(async (a: Buffer) => {
      if (!injected) {
        injected = true;
        await addPiece(w.ls, w.storage, w.startSec + 4 * PIECE_SEC);
      }
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(paragraphs(s.transcriptText)).toHaveLength(5);
    expect(stt).toHaveBeenCalledTimes(5);
  });

  it('a piece that lands after READY reopens the class: transcribed, new revision, summary told', async () => {
    if (!guard()) return;
    const w = await world(2);
    const stt = jest.fn(async (a: Buffer) => words(w)(a));
    const changed = jest.fn(async () => undefined);
    await handler(w, stt, changed).handle(job(w.ls.id, w.roomName));
    await addPiece(w.ls, w.storage, w.startSec + 2 * PIECE_SEC);
    await handler(w, stt, changed).handle(job(w.ls.id, w.roomName));
    const s = await reload(w.ls.id);
    expect(paragraphs(s.transcriptText)).toHaveLength(3);
    expect(s.transcriptRevision).toBe(2);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }));
  });
});

describe('bad answers and tiny pieces', () => {
  it('a sub-2 s tail is never sent; the transcript is still READY', async () => {
    if (!guard()) return;
    const w = await world(3, { durations: { 2: 1.7 } });
    const stt = jest.fn(async (a: Buffer) => words(w)(a));
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    expect(stt).toHaveBeenCalledTimes(2);
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect((s.transcriptMeta as any).skipped).toBe(1);
    expect((await rows(w.ls.id)).find((p) => p.skipReason)?.skipReason).toBe('TOO_SHORT');
  });

  it('the title echoed back for a short piece is silence, not words', async () => {
    if (!guard()) return;
    const w = await world(2, { durations: { 1: 6 }, title: 'مقدمة في Machine Learning' });
    const stt = jest.fn(async (a: Buffer) => (idx(w, a) === 1 ? 'مقدمة في Machine Learning.' : words(w)(a)));
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    const s = await reload(w.ls.id);
    expect(s.transcriptText).not.toMatch(/مقدمة/);
    expect(s.transcriptStatus).toBe('READY');
    expect((await rows(w.ls.id)).find((p) => p.skipReason)?.skipReason).toBe('PROMPT_ECHO');
  });

  it('the title echoed back for a long piece is lost speech: retried, and PARTIAL if it never comes back', async () => {
    if (!guard()) return;
    const w = await world(2, { title: 'مقدمة في Machine Learning' });
    const stt = jest.fn(async (a: Buffer) => (idx(w, a) === 1 ? 'مقدمة في Machine Learning' : words(w)(a)));
    const e = await handler(w, stt).handle(job(w.ls.id, w.roomName, 1)).catch((x) => x);
    expect(e.retryAfterMs).toBe(60_000);
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 4));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(s.transcriptText).not.toMatch(/مقدمة/);
  });

  it('a repetition loop is not accepted as the transcript: retried, and PARTIAL if it persists', async () => {
    if (!guard()) return;
    const w = await world(2);
    const loop = Array.from({ length: 12 }, () => 'نقول دلوقتي مين هينجح خلينا ناخد مثال من الواقع عندنا مدرسة فيها 1250 طالب').join(' ');
    const stt = jest.fn(async (a: Buffer) => (idx(w, a) === 0 ? loop : words(w)(a)));
    const e = await handler(w, stt).handle(job(w.ls.id, w.roomName, 1)).catch((x) => x);
    expect(e.errorClass).toBe('RETRYABLE');
    expect((await rows(w.ls.id)).find((p) => idx(w, Buffer.from(`a:${p.seq}`)) === 0)?.text).toBeNull();
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 4));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(s.transcriptText).not.toMatch(/مين هينجح/);
    expect((await rows(w.ls.id)).find((p) => p.error)?.error).toMatch(/REPETITION_LOOP/);
  });

  it('a teacher who repeats a sentence three times is kept as said', async () => {
    if (!guard()) return;
    const w = await world(1);
    const said = 'الامتحان يوم السبت الساعة عشرة. تاني: الامتحان يوم السبت الساعة عشرة. وتالت مرة: الامتحان يوم السبت الساعة عشرة. خلاص كده نبدأ الدرس بتاع النهارده عن الـ regression والـ classification والفرق بينهم في الأمثلة اللي هنشوفها.';
    await handler(w, jest.fn(async () => said)).handle(job(w.ls.id, w.roomName));
    expect((await reload(w.ls.id)).transcriptText).toBe(said);
  });
});

describe('recovery: PARTIAL → READY, stuck PROCESSING, retention', () => {
  function service(w: { storage: Storage }) {
    const client = { configured: true, turnConfigured: false, iceServers: jest.fn(async () => [CF_STUN]), closeTracks: jest.fn(async () => ({})), getSession: jest.fn(async () => ({ tracks: [] })) };
    const providers = new LiveProviders([new CloudflareLiveProvider(prisma, client as any)], 'CLOUDFLARE');
    const jobs = new AiJobService(prisma, { enabled: true, monthlyBudgetCents: 0 } as any);
    const svc = new LiveService(prisma, { create: jest.fn(async () => ({})) } as any, {} as any, providers, { emitToLive: jest.fn(), emitToUser: jest.fn() } as any, jobs, {} as any, w.storage as any);
    return { svc, jobs };
  }

  it("the teacher's retry recovers a PARTIAL transcript to READY, paying only for the missing piece", async () => {
    if (!guard()) return;
    const w = await world(3);
    let refuse = true;
    const stt = jest.fn(async (a: Buffer) => {
      if (refuse && idx(w, a) === 1) throw new AiJobError('Transcription refused (400)', 'TERMINAL');
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PARTIAL');
    const { svc } = service(w);
    expect(await svc.retryTranscript(w.scope as any, w.ls.id)).toEqual({ status: 'PROCESSING' });
    const queued = await prisma.aiJob.findFirst({ where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } } });
    expect(queued?.status).toBe('QUEUED');
    // A second press while it is queued queues nothing more.
    await svc.retryTranscript(w.scope as any, w.ls.id);
    expect(await prisma.aiJob.count({ where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } } })).toBe(1);
    refuse = false;
    const calls = stt.mock.calls.length;
    await handler(w, stt).handle({ ...queued, attempts: 1 } as any);
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(paragraphs(s.transcriptText)).toHaveLength(3);
    expect(stt.mock.calls.length - calls).toBe(1);
    expect(s.transcriptRevision).toBe(2);
    await prisma.aiJob.update({ where: { id: queued!.id }, data: { status: 'SUCCEEDED' } });
  });

  it('nothing to retry once the audio is gone', async () => {
    if (!guard()) return;
    const w = await world(1);
    await handler(w, jest.fn(async () => { throw new AiJobError('refused', 'TERMINAL'); })).handle(job(w.ls.id, w.roomName));
    await prisma.liveAudioSegment.updateMany({ where: { sessionId: w.ls.id }, data: { audioDeletedAt: new Date() } });
    await expect(service(w).svc.retryTranscript(w.scope as any, w.ls.id)).rejects.toMatchObject({ response: { code: 'NOTHING_TO_RETRY' } });
  });

  it('a transcript stuck PROCESSING with no job is shown as failed and decided by recovery — never an endless spinner', async () => {
    if (!guard()) return;
    const w = await world(2);
    // One piece was transcribed before the job died; the other never was, and its audio is gone.
    const r = await rows(w.ls.id);
    await prisma.liveAudioSegment.update({ where: { id: r[0].id }, data: { text: 'مقطع 0', transcribedAt: new Date(), audioDeletedAt: new Date() } });
    await prisma.liveAudioSegment.update({ where: { id: r[1].id }, data: { audioDeletedAt: new Date() } });
    const old = new Date(Date.now() - 45 * MIN);
    // Through Prisma (raw SQL would shift a Date by the database's time zone).
    await prisma.liveAudioSegment.updateMany({ where: { sessionId: w.ls.id }, data: { createdAt: old } });
    await prisma.liveSession.update({ where: { id: w.ls.id }, data: { endedAt: old, updatedAt: old } });
    const { svc } = service(w);
    const detail: any = await svc.sessionDetail(w.teacher.id, w.ls.id);
    expect(detail.transcript.stage).toBe('FAILED');
    // Recovery drains a backlog 20 classes a pass (this shared test database has older ones).
    for (let i = 0; i < 20 && (await reload(w.ls.id)).transcriptStatus === 'PROCESSING'; i++) await svc.reconcileTranscripts();
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(s.transcriptText).toBe('مقطع 0');
  });

  it('retention: a failed piece keeps its audio inside the window, and the whole class is cleaned after it', async () => {
    if (!guard()) return;
    const w = await world(2);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 1) throw new AiJobError('refused', 'TERMINAL');
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    const retention = new LiveRetentionService(prisma, w.storage as any);
    await retention.sweep();
    expect(w.storage.objects.size).toBe(1); // inside the window: kept for a retry
    const old = new Date(Date.now() - 30 * 3600_000);
    await prisma.liveAudioSegment.updateMany({ where: { sessionId: w.ls.id }, data: { createdAt: old } });
    await retention.sweep();
    expect(w.storage.objects.size).toBe(0);
    expect(await prisma.liveAudioSegment.count({ where: { sessionId: w.ls.id } })).toBe(0);
    // The transcript itself is untouched by retention.
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PARTIAL');
  });
});
