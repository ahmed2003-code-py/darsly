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
import { audioKey, classifySttRefusal, SttError } from './lesson-transcription';

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
async function world(
  pieces: number,
  opts: { durations?: Record<number, number>; title?: string } = {},
) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `tr-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `tr-${k}` } });
  await prisma.academy.create({
    data: { id: tp.id, slug: `tra-${k}`, name: `A ${k}`, ownerUserId: teacher.id },
  });
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
  const order = Array.from({ length: pieces }, (_, i) => i).sort(
    (a, b) => ((a * 7919) % pieces) - ((b * 7919) % pieces),
  );
  for (const n of order) await addPiece(ls, storage, startSec + n * PIECE_SEC, opts.durations?.[n]);
  const scope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' as const };
  return { ls, storage, startSec, roomName: ls.roomName!, tp, teacher, scope };
}
async function addPiece(
  ls: { id: string; roomName: string | null },
  storage: Storage,
  seq: number,
  durationSec = PIECE_SEC,
) {
  const key = audioKey(ls.id, ls.roomName!, seq);
  await storage.put(key, Buffer.from(`audio:${seq}`));
  return prisma.liveAudioSegment.create({
    data: {
      sessionId: ls.id,
      roomName: ls.roomName!,
      seq,
      key,
      sizeBytes: 720_000,
      durationMs: durationSec * 1000,
    },
  });
}
const seqOf = (audio: Buffer) => Number(audio.toString().split(':')[1]);
const idx = (w: { startSec: number }, audio: Buffer) => (seqOf(audio) - w.startSec) / PIECE_SEC;
const words = (w: { startSec: number }) => (audio: Buffer) =>
  `مقطع ${idx(w, audio)} — supervised learning`;
const job = (liveSessionId: string, roomName: string, attempts = 1) =>
  ({
    id: `job-${randomUUID().slice(0, 8)}`,
    type: 'LIVE_TRANSCRIBE',
    attempts,
    input: { liveSessionId, roomName },
  }) as any;
const noSleep = async () => undefined;
const reload = (id: string) => prisma.liveSession.findUniqueOrThrow({ where: { id } });
const paragraphs = (t: string | null) => (t ?? '').split('\n\n').filter(Boolean);
const rows = (sessionId: string) =>
  prisma.liveAudioSegment.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
const handler = (w: { storage: Storage }, stt: any, onChanged?: any) =>
  new LiveTranscribeHandler(prisma, w.storage as any, stt, noSleep, onChanged);

describe('long classes: every piece once, in order', () => {
  for (const [label, n] of [
    ['1 piece', 1],
    ['1 hour', 20],
    ['3 hours', 60],
  ] as const) {
    it(`${label}: READY, chronological, audio deleted only after each piece's words are saved`, async () => {
      if (!guard()) return;
      const w = await world(n);
      const stt = jest.fn(async (a: Buffer) => words(w)(a));
      const changed = jest.fn(async () => undefined);
      await handler(w, stt, changed).handle(job(w.ls.id, w.roomName));
      const s = await reload(w.ls.id);
      expect(s.transcriptStatus).toBe('READY');
      expect(stt).toHaveBeenCalledTimes(n);
      expect(paragraphs(s.transcriptText)).toEqual(
        Array.from({ length: n }, (_, i) => `مقطع ${i} — supervised learning`),
      );
      expect(w.storage.objects.size).toBe(0);
      const r = await rows(w.ls.id);
      expect(r.every((p) => p.text && p.audioDeletedAt)).toBe(true);
      expect(s.transcriptRevision).toBe(1);
      expect(changed).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: w.ls.id, status: 'READY', revision: 1 }),
      );
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
        if (idx(w, a) === bad)
          throw new AiJobError('Transcription refused (400): bad audio', 'TERMINAL');
        return words(w)(a);
      });
      await handler(w, stt).handle(job(w.ls.id, w.roomName));
      const s = await reload(w.ls.id);
      expect(s.transcriptStatus).toBe('PARTIAL');
      expect(s.transcriptMeta as any).toMatchObject({ partial: true, failed: 1, pieces: 5 });
      expect(paragraphs(s.transcriptText)).toHaveLength(4);
      const failed = (await rows(w.ls.id)).find((p) => p.error)!;
      expect(w.storage.objects.has(failed.key)).toBe(true);
      expect(w.storage.objects.size).toBe(1);
      const st = pipelineStages({
        provider: 'CLOUDFLARE',
        transcriptStatus: s.transcriptStatus,
        hasTranscriptText: true,
        summaryStatus: 'NOT_STARTED',
        summaryError: null,
        recordingStage: null,
        transcriptionOn: true,
      });
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
  it('a lasting 503 on pieces 4–6 → quick retries, then the job asks to be retried in ≈30 s; what was saved stays; the next attempt finishes READY', async () => {
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
    expect(err.retryAfterMs).toBe(30_000);
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

  it('the retry schedule is 30 s, 2, 8 minutes; only the 4th attempt gives up — and then PARTIAL, audio kept', async () => {
    if (!guard()) return;
    const w = await world(3);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 2)
        throw new AiJobError('Transcription unreachable: TimeoutError', 'RETRYABLE');
      return words(w)(a);
    });
    const h = handler(w, stt);
    const delays: number[] = [];
    for (const attempt of [1, 2, 3]) {
      const e = await h.handle(job(w.ls.id, w.roomName, attempt)).catch((x) => x);
      delays.push(e.retryAfterMs);
    }
    expect(delays).toEqual([30_000, 2 * 60_000, 8 * 60_000]);
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
    const j = await prisma.aiJob.create({
      data: {
        academyId: w.tp.id,
        type: 'LIVE_TRANSCRIBE',
        input: { liveSessionId: w.ls.id, roomName: w.roomName },
        status: 'RUNNING',
        attempts: 1,
      },
    });
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
    await prisma.aiJob.update({
      where: { id: j.id },
      data: { runAfter: new Date(Date.now() - 1000) },
    });
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
  it('a worker that dies mid-call: the next owner pays only for the piece never saved, kept once', async () => {
    if (!guard()) return;
    const w = await world(3);
    let died = false;
    const stt = jest.fn(async (a: Buffer) => {
      if (!died && idx(w, a) === 1) {
        died = true;
        // The provider answered, but this worker never lives to save it.
        return new Promise<string>(() => undefined);
      }
      return words(w)(a);
    });
    void handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    await new Promise((r) => setTimeout(r, 300));
    // The dead worker's lease expires (it never released it).
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { transcriptLeaseUntil: new Date(Date.now() - 1000) },
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 2));
    expect(paragraphs((await reload(w.ls.id)).transcriptText)).toEqual(
      [0, 1, 2].map((i) => `مقطع ${i} — supervised learning`),
    );
    // Pieces 0 and 2 once, piece 1 twice (the lost answer, then the new owner's).
    expect(stt.mock.calls.map((c) => idx(w, c[0])).sort()).toEqual([0, 1, 1, 2]);
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
        await prisma.liveSession.update({
          where: { id: w.ls.id },
          data: {
            transcriptLeaseJobId: 'other-job',
            transcriptLeaseUntil: new Date(Date.now() + TRANSCRIPT_LEASE_MS),
          },
        });
      }
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    // Pieces 0–2 were already under way (three at a time); piece 3 is never started.
    expect(stt.mock.calls.map((c) => idx(w, c[0])).sort()).toEqual([0, 1, 2]);
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
    const stt = jest.fn(async (a: Buffer) =>
      idx(w, a) === 1 ? 'مقدمة في Machine Learning.' : words(w)(a),
    );
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    const s = await reload(w.ls.id);
    expect(s.transcriptText).not.toMatch(/مقدمة/);
    expect(s.transcriptStatus).toBe('READY');
    expect((await rows(w.ls.id)).find((p) => p.skipReason)?.skipReason).toBe('PROMPT_ECHO');
  });

  it('the title echoed back for a long piece is lost speech: asked again at once WITHOUT the title, and kept when it comes back', async () => {
    if (!guard()) return;
    const w = await world(2, { title: 'مقدمة في Machine Learning' });
    const stt = jest.fn(async (a: Buffer, _f: string, o?: { prompt?: string }) =>
      idx(w, a) === 1 && o?.prompt ? 'مقدمة في Machine Learning' : words(w)(a),
    );
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(paragraphs(s.transcriptText)).toHaveLength(2);
    expect(stt).toHaveBeenCalledTimes(3);
    expect(stt.mock.calls.filter((c) => !c[2]?.prompt)).toHaveLength(1);
  });

  it('an echo that comes back twice fails that piece at once: PARTIAL in the first run, no 15-minute wait', async () => {
    if (!guard()) return;
    const w = await world(2, { title: 'مقدمة في Machine Learning' });
    const stt = jest.fn(async (a: Buffer) =>
      idx(w, a) === 1 ? 'مقدمة في Machine Learning' : words(w)(a),
    );
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(s.transcriptText).not.toMatch(/مقدمة/);
    expect((await rows(w.ls.id)).find((p) => p.error)?.error).toMatch(
      /^GUARD_REJECTED: PROMPT_ECHO/,
    );
    expect(stt).toHaveBeenCalledTimes(3);
  });

  it('a repetition loop is not accepted: asked again once; a second loop fails that piece (PARTIAL), a good second answer is kept', async () => {
    if (!guard()) return;
    const loop = Array.from(
      { length: 12 },
      () => 'نقول دلوقتي مين هينجح خلينا ناخد مثال من الواقع عندنا مدرسة فيها 1250 طالب',
    ).join(' ');
    const w = await world(2);
    const stt = jest.fn(async (a: Buffer) => (idx(w, a) === 0 ? loop : words(w)(a)));
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    let s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(s.transcriptText).not.toMatch(/مين هينجح/);
    expect((await rows(w.ls.id)).find((p) => p.error)?.error).toMatch(
      /^GUARD_REJECTED: REPETITION_LOOP/,
    );
    // Both rejected answers were paid for, and both are on the call log.
    expect(
      await prisma.aiCallLog.count({ where: { liveSessionId: w.ls.id, status: 'loop' } }),
    ).toBe(2);

    const w2 = await world(1);
    let first = true;
    const stt2 = jest.fn(async (a: Buffer) => (first ? ((first = false), loop) : words(w2)(a)));
    await handler(w2, stt2).handle(job(w2.ls.id, w2.roomName, 1));
    s = await reload(w2.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(stt2).toHaveBeenCalledTimes(2);
  });

  it('a teacher who repeats a sentence three times is kept as said', async () => {
    if (!guard()) return;
    const w = await world(1);
    const said =
      'الامتحان يوم السبت الساعة عشرة. تاني: الامتحان يوم السبت الساعة عشرة. وتالت مرة: الامتحان يوم السبت الساعة عشرة. خلاص كده نبدأ الدرس بتاع النهارده عن الـ regression والـ classification والفرق بينهم في الأمثلة اللي هنشوفها.';
    await handler(
      w,
      jest.fn(async () => said),
    ).handle(job(w.ls.id, w.roomName));
    expect((await reload(w.ls.id)).transcriptText).toBe(said);
  });
});

describe('recovery: PARTIAL → READY, stuck PROCESSING, retention', () => {
  function service(w: { storage: Storage }) {
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
    const svc = new LiveService(
      prisma,
      { create: jest.fn(async () => ({})) } as any,
      {} as any,
      providers,
      { emitToLive: jest.fn(), emitToUser: jest.fn() } as any,
      jobs,
      {} as any,
      w.storage as any,
    );
    return { svc, jobs };
  }

  it("the teacher's retry recovers a PARTIAL transcript to READY, paying only for the missing piece", async () => {
    if (!guard()) return;
    const w = await world(3);
    let refuse = true;
    const stt = jest.fn(async (a: Buffer) => {
      if (refuse && idx(w, a) === 1)
        throw new AiJobError('Transcription refused (400)', 'TERMINAL');
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName));
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PARTIAL');
    const { svc } = service(w);
    expect(await svc.retryTranscript(w.scope as any, w.ls.id)).toEqual({ status: 'PROCESSING' });
    const queued = await prisma.aiJob.findFirst({
      where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
    });
    expect(queued?.status).toBe('QUEUED');
    // A second press while it is queued queues nothing more.
    await svc.retryTranscript(w.scope as any, w.ls.id);
    expect(
      await prisma.aiJob.count({
        where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
      }),
    ).toBe(1);
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
    await handler(
      w,
      jest.fn(async () => {
        throw new AiJobError('refused', 'TERMINAL');
      }),
    ).handle(job(w.ls.id, w.roomName));
    await prisma.liveAudioSegment.updateMany({
      where: { sessionId: w.ls.id },
      data: { audioDeletedAt: new Date() },
    });
    await expect(service(w).svc.retryTranscript(w.scope as any, w.ls.id)).rejects.toMatchObject({
      response: { code: 'NOTHING_TO_RETRY' },
    });
  });

  it('a transcript stuck PROCESSING with no job is shown as failed and decided by recovery — never an endless spinner', async () => {
    if (!guard()) return;
    const w = await world(2);
    // One piece was transcribed before the job died; the other never was, and its audio is gone.
    const r = await rows(w.ls.id);
    await prisma.liveAudioSegment.update({
      where: { id: r[0].id },
      data: { text: 'مقطع 0', transcribedAt: new Date(), audioDeletedAt: new Date() },
    });
    await prisma.liveAudioSegment.update({
      where: { id: r[1].id },
      data: { audioDeletedAt: new Date() },
    });
    const old = new Date(Date.now() - 45 * MIN);
    // Through Prisma (raw SQL would shift a Date by the database's time zone).
    await prisma.liveAudioSegment.updateMany({
      where: { sessionId: w.ls.id },
      data: { createdAt: old },
    });
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { endedAt: old, updatedAt: old },
    });
    const { svc } = service(w);
    const detail: any = await svc.sessionDetail(w.teacher.id, w.ls.id);
    expect(detail.transcript.stage).toBe('FAILED');
    // Recovery drains a backlog 20 classes a pass (this shared test database has older ones).
    for (let i = 0; i < 20 && (await reload(w.ls.id)).transcriptStatus === 'PROCESSING'; i++)
      await svc.reconcileTranscripts();
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
    await prisma.liveAudioSegment.updateMany({
      where: { sessionId: w.ls.id },
      data: { createdAt: old },
    });
    await retention.sweep();
    expect(w.storage.objects.size).toBe(0);
    expect(await prisma.liveAudioSegment.count({ where: { sessionId: w.ls.id } })).toBe(0);
    // The transcript itself is untouched by retention.
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PARTIAL');
  });
});

/**
 * The 2026-09-27 production failure (class cmuk5pkhb…, 3 min 44 s): two pieces,
 * 180 s + 21.6 s; OpenAI answered every call with 429 insufficient_quota (no
 * credits). The queue treated it as a rate limit and waited 1, 5 and 15
 * minutes: FAILED 22 minutes after the class, having never had a chance.
 */
describe('smart retries: failures handled by what they are', () => {
  const PROD_BODY = JSON.stringify({
    error: {
      message:
        'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      type: 'insufficient_quota',
      param: null,
      code: 'insufficient_quota',
    },
  });
  const noCredits = () => classifySttRefusal(429, PROD_BODY);
  function service(w: { storage: Storage }) {
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
      w.storage as any,
    );
  }
  const sleeps = () => {
    const waited: number[] = [];
    return { waited, sleep: async (ms: number) => void waited.push(ms) };
  };

  it('REPRODUCED: 180 s + 21.6 s, every call "429 insufficient_quota" → decided in the FIRST run: FAILED (service unavailable), audio kept, no retry scheduled', async () => {
    if (!guard()) return;
    const w = await world(2, { durations: { 1: 21.568 } });
    const stt = jest.fn(async () => {
      throw noCredits();
    });
    const { waited, sleep } = sleeps();
    // The run ends normally: no RETRYABLE error, so the queue schedules nothing.
    await new LiveTranscribeHandler(prisma, w.storage as any, stt, sleep).handle(
      job(w.ls.id, w.roomName, 1),
    );
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('FAILED');
    expect(s.transcriptMeta).toMatchObject({
      reason: 'PROVIDER_UNAVAILABLE',
      providerUnavailable: 2,
      failed: 2,
    });
    // Never retried the same refusal: at most one call per piece, no waits.
    expect(stt.mock.calls.length).toBeLessThanOrEqual(2);
    expect(waited).toEqual([]);
    const r = await rows(w.ls.id);
    expect(r.every((p) => p.error === 'PROVIDER_UNAVAILABLE: 429 insufficient_quota')).toBe(true);
    expect(w.storage.objects.size).toBe(2);
    // Every call is on the log, classified, and none of them billed.
    const log = await prisma.aiCallLog.findMany({ where: { liveSessionId: w.ls.id } });
    expect(log).toHaveLength(stt.mock.calls.length);
    expect(
      log.every((c) => c.error === 'ACCOUNT: 429 insufficient_quota' && c.costMillicents === 0),
    ).toBe(true);
    // The teacher sees why, and can retry once the account is fixed.
    const d: any = await service(w).sessionDetail(w.teacher.id, w.ls.id);
    expect(d.transcript).toMatchObject({
      stage: 'FAILED',
      reason: 'SERVICE_UNAVAILABLE',
      canRetry: true,
    });
    expect(d.summary.stage).toBe('UNAVAILABLE');
  });

  it('…and once the account is fixed, the teacher retry makes it READY, paying for those two pieces only', async () => {
    if (!guard()) return;
    const w = await world(2, { durations: { 1: 21.568 } });
    let broke = true;
    const stt = jest.fn(async (a: Buffer) => {
      if (broke) throw noCredits();
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    const svc = service(w);
    await svc.retryTranscript(w.scope as any, w.ls.id);
    const queued = await prisma.aiJob.findFirstOrThrow({
      where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
    });
    // A second press while it is queued queues nothing more.
    await svc.retryTranscript(w.scope as any, w.ls.id);
    expect(
      await prisma.aiJob.count({
        where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
      }),
    ).toBe(1);
    const detail: any = await svc.sessionDetail(w.teacher.id, w.ls.id);
    expect(detail.transcript).toMatchObject({
      stage: 'TRANSCRIBING',
      progress: { done: 0, total: 2 },
    });
    broke = false;
    const before = stt.mock.calls.length;
    const changed = jest.fn(async () => undefined);
    await handler(w, stt, changed).handle({ ...queued, attempts: 1 } as any);
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(stt.mock.calls.length - before).toBe(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(w.storage.objects.size).toBe(0);
    await prisma.aiJob.update({ where: { id: queued.id }, data: { status: 'SUCCEEDED' } });
  });

  it('credits run out mid-class: what was transcribed is kept (PARTIAL), the rest is marked at once, no blind retries', async () => {
    if (!guard()) return;
    const w = await world(6);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) >= 3) throw noCredits();
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('PARTIAL');
    expect(paragraphs(s.transcriptText)).toEqual(
      [0, 1, 2].map((i) => `مقطع ${i} — supervised learning`),
    );
    expect((s.transcriptMeta as any).providerUnavailable).toBe(3);
    // Stopped sending once the account was refused.
    expect(stt.mock.calls.filter((c) => idx(w, c[0]) >= 3).length).toBeLessThanOrEqual(3);
  });

  it('a true rate limit: waits what it was told (capped), then carries on in the same run', async () => {
    if (!guard()) return;
    const w = await world(2);
    let limited = 1;
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 1 && limited-- > 0)
        throw classifySttRefusal(
          429,
          JSON.stringify({ error: { code: 'rate_limit_exceeded' } }),
          '7',
        );
      return words(w)(a);
    });
    const { waited, sleep } = sleeps();
    await new LiveTranscribeHandler(prisma, w.storage as any, stt, sleep).handle(
      job(w.ls.id, w.roomName, 1),
    );
    expect((await reload(w.ls.id)).transcriptStatus).toBe('READY');
    expect(waited).toEqual([7000]);
  });

  it('a lasting rate limit: nothing new is started, and the queue retries no sooner than Retry-After', async () => {
    if (!guard()) return;
    const w = await world(6);
    const stt = jest.fn(async () => {
      throw classifySttRefusal(
        429,
        JSON.stringify({ error: { code: 'rate_limit_exceeded' } }),
        '90',
      );
    });
    const e = await handler(w, stt)
      .handle(job(w.ls.id, w.roomName, 1))
      .catch((x) => x);
    expect(e).toMatchObject({ errorClass: 'RETRYABLE', retryAfterMs: 90_000 });
    // Three lanes, two tries each at most: never six pieces hammered.
    expect(stt.mock.calls.length).toBeLessThanOrEqual(6);
    expect((await rows(w.ls.id)).every((p) => p.error === null)).toBe(true);
  });

  it('a 500 or a timeout once: retried a couple of seconds later in the same run, READY without the queue', async () => {
    if (!guard()) return;
    const w = await world(3);
    const hiccups = new Map<number, Error>([
      [0, classifySttRefusal(500, '')],
      [2, new SttError('TIMEOUT', 'TimeoutError')],
    ]);
    const stt = jest.fn(async (a: Buffer) => {
      const e = hiccups.get(idx(w, a));
      if (e) {
        hiccups.delete(idx(w, a));
        throw e;
      }
      return words(w)(a);
    });
    const { waited, sleep } = sleeps();
    await new LiveTranscribeHandler(prisma, w.storage as any, stt, sleep).handle(
      job(w.ls.id, w.roomName, 1),
    );
    expect((await reload(w.ls.id)).transcriptStatus).toBe('READY');
    expect(waited).toEqual([2000, 2000]);
    expect(stt).toHaveBeenCalledTimes(5);
  });

  it('one piece down does not hold up the others: the rest are transcribed in the same run', async () => {
    if (!guard()) return;
    const w = await world(5);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 0) throw classifySttRefusal(503, '');
      return words(w)(a);
    });
    const e = await handler(w, stt)
      .handle(job(w.ls.id, w.roomName, 1))
      .catch((x) => x);
    expect(e.retryAfterMs).toBe(30_000);
    // Pieces 1–4 are saved already; only piece 0 is owed.
    const r = await rows(w.ls.id);
    expect(r.filter((p) => p.text).length).toBe(4);
    expect(stt.mock.calls.filter((c) => idx(w, c[0]) === 0)).toHaveLength(3);
  });

  it('a file the provider cannot read fails that piece alone, and the retry button does not offer it', async () => {
    if (!guard()) return;
    const w = await world(2);
    const stt = jest.fn(async (a: Buffer) => {
      if (idx(w, a) === 1)
        throw classifySttRefusal(400, JSON.stringify({ error: { code: 'invalid_value' } }));
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    expect((await reload(w.ls.id)).transcriptStatus).toBe('PARTIAL');
    expect(stt).toHaveBeenCalledTimes(2);
    expect((await rows(w.ls.id)).find((p) => p.error)?.error).toMatch(/^BAD_AUDIO/);
    const d: any = await service(w).sessionDetail(w.teacher.id, w.ls.id);
    expect(d.transcript.canRetry).toBe(false);
    await expect(service(w).retryTranscript(w.scope as any, w.ls.id)).rejects.toMatchObject({
      response: { code: 'NOTHING_TO_RETRY' },
    });
  });

  it('a 3-minute teacher-only class: one 180 s piece → READY in one call, one call logged', async () => {
    if (!guard()) return;
    const w = await world(1);
    const stt = jest.fn(async (a: Buffer) => words(w)(a));
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    expect((await reload(w.ls.id)).transcriptStatus).toBe('READY');
    expect(stt).toHaveBeenCalledTimes(1);
    expect(await prisma.aiCallLog.count({ where: { liveSessionId: w.ls.id } })).toBe(1);
  });

  it('nothing said in any piece → FAILED "no speech", not a failure', async () => {
    if (!guard()) return;
    const w = await world(2);
    await handler(
      w,
      jest.fn(async () => ''),
    ).handle(job(w.ls.id, w.roomName, 1));
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('FAILED');
    expect((s.transcriptMeta as any).reason).toBe('NO_SPEECH');
  });

  it('Egyptian Arabic with English terms is kept exactly as answered: no guard trips on it', async () => {
    if (!guard()) return;
    const w = await world(1, { title: 'Machine Learning' });
    const said =
      'طيب يا جماعة النهارده هنتكلم عن الـ overfitting، يعني الموديل بيحفظ الـ training data بدل ما يتعلم منها. ' +
      'عشان كده بنعمل validation set ونشوف الـ loss بيقل ولا لأ، ولو الـ accuracy على الـ test وحشة يبقى عندنا مشكلة.';
    await handler(
      w,
      jest.fn(async () => said),
    ).handle(job(w.ls.id, w.roomName, 1));
    expect((await reload(w.ls.id)).transcriptText).toBe(said);
  });

  it('the upload window: work starts on the pieces already here, the late last piece is waited for and included, then decided', async () => {
    if (!guard()) return;
    const w = await world(2);
    // The class ended 10 s ago: the last piece may still arrive for ≈40 s.
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { endedAt: new Date(Date.now() - 10_000) },
    });
    const order: string[] = [];
    const stt = jest.fn(async (a: Buffer) => {
      order.push(`stt ${idx(w, a)}`);
      return words(w)(a);
    });
    // A virtual clock: waiting moves time on.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const sleep = async (ms: number) => {
      order.push('wait');
      expect(ms).toBeGreaterThan(30_000);
      expect(ms).toBeLessThanOrEqual(40_000);
      // The final flush lands during the window.
      await addPiece(w.ls, w.storage, w.startSec + 2 * PIECE_SEC, 21);
      offset += ms;
    };
    try {
      await new LiveTranscribeHandler(prisma, w.storage as any, stt, sleep).handle(
        job(w.ls.id, w.roomName, 1),
      );
    } finally {
      now.mockRestore();
    }
    expect(order.slice(0, 2).sort()).toEqual(['stt 0', 'stt 1']);
    expect(order.slice(2)).toEqual(['wait', 'stt 2']);
    const s = await reload(w.ls.id);
    expect(s.transcriptStatus).toBe('READY');
    expect(paragraphs(s.transcriptText)).toHaveLength(3);
    expect(s.transcriptRevision).toBe(1);
  });

  it('a long class: never more than three calls in flight, every piece once, in spoken order', async () => {
    if (!guard()) return;
    const w = await world(20);
    let inFlight = 0;
    let peak = 0;
    // Each call holds until three are in flight (or half a second passes),
    // then a little longer — so reaching the limit does not depend on how busy
    // the machine is (a fixed 5 ms call used to finish before the third began
    // on a loaded box), and a fourth lane, if there were one, would have to
    // start while the three are still held. A pool of two waits out the half
    // second and fails; a pool of four shows a peak of four and fails.
    const stt = jest.fn(async (a: Buffer) => {
      peak = Math.max(peak, ++inFlight);
      const until = Date.now() + 500;
      while (inFlight < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return words(w)(a);
    });
    await handler(w, stt).handle(job(w.ls.id, w.roomName, 1));
    expect(peak).toBe(3);
    expect(stt).toHaveBeenCalledTimes(20);
    expect(paragraphs((await reload(w.ls.id)).transcriptText)).toEqual(
      Array.from({ length: 20 }, (_, i) => `مقطع ${i} — supervised learning`),
    );
    expect(await prisma.aiCallLog.count({ where: { liveSessionId: w.ls.id } })).toBe(20);
  });
});
