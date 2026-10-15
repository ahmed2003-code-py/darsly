import { databaseReady } from '../../common/testing/db-available';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../../academy-site/academy-site.config';
import { AiJobService } from '../../academy-site/jobs/ai-job.service';
import { AcademyService } from '../../academy/academy.service';
import { LiveService } from '../live.service';
import { LiveRtcService } from '../rtc/live-rtc.service';
import { LiveRecordingService, UNCLAIMED_AFTER_MS } from '../recording/live-recording.service';
import { classroom, classroomWorld, codeOf, type ClassroomWorld } from '../testing/classroom';
import { LiveCaptureService, CAPTURE_LEASE_TTL_MS } from './capture-lease.service';
import { transcriptCaptureState } from './capture-state';
import { LiveTranscribeHandler, TRANSCRIBE_CONCURRENCY } from './live-transcribe.handler';
import { SttError, type SpeechToText } from './lesson-transcription';
import type { TranscriptMeta } from './transcript-assembly';

/**
 * The lesson's audio, from the teacher's intent to a transcript that says
 * whether it is complete — on a real PostgreSQL, with a fake speech-to-text
 * (it is a paid call) and storage in memory.
 *
 *  - A video recorder that never starts does not stop the transcript.
 *  - One tab captures; a second is refused, and takes over only when the first
 *    goes quiet; a piece from the tab that lost the lease is refused.
 *  - A piece delivered late (offline, a reload) is still taken if it was
 *    spoken while capture was on.
 *  - READY means the pieces cover what the teacher asked to keep; a gap or a
 *    piece that never arrived is PARTIAL — until it arrives.
 *  - A long lecture, and a class reopened inside its window, come out whole
 *    and in order; one job per class.
 */
const prisma = new PrismaService();
let available = true;
const MIN = 60_000;
const env = { ...process.env };

beforeAll(async () => {
  available = await databaseReady(prisma, [
    'liveSession',
    'liveAudioSegment',
    'liveCaptureSpan',
    'liveCaptureLease',
    'liveAudioManifest',
  ]);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
beforeEach(() => {
  process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  process.env.AI_ACADEMY_ENABLED = 'true';
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
    deletePrefix: async () => undefined,
    exists: async (key: string) => objects.has(key),
  };
}

/** A WebM piece: the EBML magic, then the second it was spoken (the fake STT reads it back). */
const webm = (seq: number) => {
  const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  return Buffer.concat([head, Buffer.from(`SEQ:${seq};`.padEnd(400, '.'))]);
};
const file = (seq: number) => {
  const buffer = webm(seq);
  return { buffer, size: buffer.length, mimetype: 'audio/webm' };
};
/** Says which second it heard: the transcript's order is checkable. */
const echoStt: SpeechToText = async (audio) => {
  const m = /SEQ:(\d+);/.exec(audio.toString('latin1'));
  return `words of ${m?.[1] ?? '?'}`;
};

function stack(stt: SpeechToText = echoStt) {
  const c = classroom(prisma);
  const storage = memoryStorage();
  const jobs = new AiJobService(prisma, new AcademySiteConfig());
  const live = new LiveService(
    prisma,
    { create: async () => ({}) } as never,
    { recordOrThrow: async () => ({}) } as never,
    (c.live as any).providers,
    c.realtime as never,
    jobs,
    new AcademyService(prisma),
    storage as never,
  );
  const rtc = new LiveRtcService(prisma, live, c.cloudflare, c.realtime as never);
  const recordings = new LiveRecordingService(prisma, live, rtc);
  const capture = new LiveCaptureService(prisma, live);
  const handler = new LiveTranscribeHandler(prisma, storage as never, stt, async () => undefined);
  return { c, storage, jobs, live, rtc, recordings, capture, handler };
}
type S = ReturnType<typeof stack>;

/** Run the class's transcription job once, as the worker would. */
async function transcribe(s: S, w: ClassroomWorld) {
  const job = await prisma.aiJob.findFirst({
    where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
    orderBy: { createdAt: 'desc' },
  });
  if (!job) throw new Error('no transcription job queued');
  await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 1 } });
  try {
    await s.handler.handle({ ...job, attempts: 1 });
    await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED' } });
  } catch (e) {
    await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
    throw e;
  }
  return prisma.liveSession.findUniqueOrThrow({ where: { id: w.ls.id } });
}

const secOf = (ms: number) => Math.floor(ms / 1000);

/** An ended class whose teacher kept [startMs, endMs] (one span), with its pieces delivered. */
async function endedClass(
  s: S,
  o: { pieces: { atMs: number; lenMs: number }[]; spanFrom: number; spanTo: number; run?: string },
) {
  const w = await classroomWorld(prisma, {
    status: 'ENDED',
    startedAt: new Date(o.spanFrom - 30_000),
    endedAt: new Date(o.spanTo),
    transcriptionMode: 'AUTO_WHEN_RECORDING',
  });
  const run = o.run ?? w.ls.roomName!;
  await prisma.liveCaptureSpan.create({
    data: {
      sessionId: w.ls.id,
      roomName: run,
      source: 'RECORDING',
      startedAt: new Date(o.spanFrom),
      endedAt: new Date(o.spanTo),
    },
  });
  const lease = await prisma.liveCaptureLease.create({
    data: { sessionId: w.ls.id, roomName: run, userId: w.teacher.id, tabId: 'tab-aaaaaaaa' },
  });
  for (const p of o.pieces) await putPiece(s, w, run, secOf(p.atMs), p.lenMs, lease.id);
  return { w, run, lease };
}
async function putPiece(
  s: S,
  w: ClassroomWorld,
  run: string,
  seq: number,
  lenMs: number,
  leaseId: string,
  state: 'QUEUED' | 'SILENT' = 'QUEUED',
) {
  await prisma.liveAudioManifest.create({
    data: { sessionId: w.ls.id, roomName: run, seq, durationMs: lenMs, state, leaseId },
  });
  if (state === 'SILENT') return;
  const key = `source/live-audio/${w.ls.id}/${run}/${seq}.webm`;
  await s.storage.put(key, webm(seq));
  await prisma.liveAudioSegment.create({
    data: { sessionId: w.ls.id, roomName: run, seq, key, sizeBytes: 400, durationMs: lenMs },
  });
}
const queue = (s: S, w: ClassroomWorld) =>
  s.jobs.enqueue(
    w.tp.id,
    'LIVE_TRANSCRIBE',
    { liveSessionId: w.ls.id, roomName: w.ls.roomName },
    { sameInput: { path: 'liveSessionId', equals: w.ls.id } },
  );
const metaOf = (row: { transcriptMeta: unknown }) => row.transcriptMeta as TranscriptMeta;

describe('a recorder that fails does not stop the transcript', () => {
  it('NOT_CLAIMED: the video fails, capture keeps going, the teacher sees why; stop ends both', async () => {
    if (!guard()) return;
    const s = stack();
    const w = await classroomWorld(prisma, { transcriptionMode: 'AUTO_WHEN_RECORDING' });
    const started = await s.recordings.start(w.scope, w.ls.id, w.teacher.id);
    expect(started).toMatchObject({ stage: 'REQUESTED', intent: true });
    expect((await transcriptCaptureState(prisma, w.ls.id, w.ls.roomName)).active).toBe(true);
    expect(
      await prisma.liveCaptureSpan.count({ where: { sessionId: w.ls.id, endedAt: null } }),
    ).toBe(1);

    // No recorder anywhere: the request is never claimed.
    await prisma.liveRecording.update({
      where: { id: started.id },
      data: { createdAt: new Date(Date.now() - UNCLAIMED_AFTER_MS - 5_000) },
    });
    await s.recordings.sweepStale();
    const rec = await prisma.liveRecording.findUniqueOrThrow({ where: { id: started.id } });
    expect(rec).toMatchObject({ status: 'FAILED', error: 'NOT_CLAIMED', stopRequestedAt: null });

    // The lesson's words are still being kept, and the classroom says so —
    // with the recorder's failure shown, not a badge that quietly vanished.
    expect((await transcriptCaptureState(prisma, w.ls.id, w.ls.roomName)).active).toBe(true);
    const state = await s.rtc.state(w.teacher.id, w.ls.id);
    expect(state.recording).toBe(false);
    expect(state.transcribing).toBe(true);
    expect(state.recordingState).toMatchObject({
      stage: 'FAILED',
      failure: 'NOT_STARTED',
      intent: true,
    });
    // A piece spoken now is taken.
    const seq = secOf(Date.now());
    expect(await codeOf(s.live.storeAudioPiece(w.scope, w.ls.id, seq, file(seq)))).toBe('ok');

    // The teacher's stop ends the intent, and capture with it.
    await s.recordings.stop(w.scope, w.ls.id);
    expect((await transcriptCaptureState(prisma, w.ls.id, w.ls.roomName)).active).toBe(false);
    expect(
      await prisma.liveCaptureSpan.count({ where: { sessionId: w.ls.id, endedAt: null } }),
    ).toBe(0);
    expect((await s.rtc.state(w.teacher.id, w.ls.id)).recordingState?.intent).toBe(false);
  });

  it('record → stop → record: two spans, capture follows each', async () => {
    if (!guard()) return;
    const s = stack();
    const w = await classroomWorld(prisma, { transcriptionMode: 'AUTO_WHEN_RECORDING' });
    await s.recordings.start(w.scope, w.ls.id, w.teacher.id);
    await s.recordings.stop(w.scope, w.ls.id);
    expect((await transcriptCaptureState(prisma, w.ls.id, w.ls.roomName)).active).toBe(false);
    await s.recordings.start(w.scope, w.ls.id, w.teacher.id);
    expect((await transcriptCaptureState(prisma, w.ls.id, w.ls.roomName)).active).toBe(true);
    const spans = await prisma.liveCaptureSpan.findMany({ where: { sessionId: w.ls.id } });
    expect(spans.length).toBe(2);
    expect(spans.filter((x) => !x.endedAt).length).toBe(1);
  });
});

describe('one tab captures a class', () => {
  it('a second tab is refused, takes over only when the first goes quiet, and the first loses its pieces after that', async () => {
    if (!guard()) return;
    const s = stack();
    const w = await classroomWorld(prisma, { transcriptionMode: 'AUTO_WHEN_RECORDING' });
    await s.recordings.start(w.scope, w.ls.id, w.teacher.id);
    const a = await s.capture.claim(w.scope, w.ls.id, w.teacher.id, 'tab-aaaaaaaa');
    expect(a.capturing).toBe(true);
    // A reload of the same tab gets its lease back.
    expect((await s.capture.claim(w.scope, w.ls.id, w.teacher.id, 'tab-aaaaaaaa')).leaseId).toBe(
      a.leaseId,
    );
    expect(await codeOf(s.capture.claim(w.scope, w.ls.id, w.teacher.id, 'tab-bbbbbbbb'))).toBe(
      'CAPTURE_ELSEWHERE',
    );
    const before = secOf(Date.now()) - 5;
    expect(
      await codeOf(
        s.live.storeAudioPiece(w.scope, w.ls.id, before, file(before), 5000, {
          uploaderUserId: w.teacher.id,
          leaseId: a.leaseId,
        }),
      ),
    ).toBe('ok');

    // Tab A goes quiet past the TTL: B takes over.
    await prisma.liveCaptureLease.update({
      where: { id: a.leaseId },
      data: {
        lastBeatAt: new Date(Date.now() - CAPTURE_LEASE_TTL_MS - 1_000),
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    const b = await s.capture.claim(w.scope, w.ls.id, w.teacher.id, 'tab-bbbbbbbb');
    expect(b.leaseId).not.toBe(a.leaseId);
    expect(
      await codeOf(
        s.capture.beat(w.scope, w.ls.id, w.teacher.id, {
          leaseId: a.leaseId,
          tabId: 'tab-aaaaaaaa',
        }),
      ),
    ).toBe('CAPTURE_LEASE_LOST');
    // A piece A recorded before B took over still counts; one after is a duplicate.
    const after = secOf(Date.now()) + 1;
    expect(
      await codeOf(
        s.live.storeAudioPiece(w.scope, w.ls.id, after, file(after), 5000, {
          uploaderUserId: w.teacher.id,
          leaseId: a.leaseId,
        }),
      ),
    ).toBe('CAPTURE_ELSEWHERE');
    const beatB = await s.capture.beat(w.scope, w.ls.id, w.teacher.id, {
      leaseId: b.leaseId,
      tabId: 'tab-bbbbbbbb',
      audioOk: true,
      stats: { created: 2, uploaded: 1, pending: 1, dropped: 0, silent: 0 },
      pieces: [
        { seq: after, durationMs: 5000, state: 'QUEUED' },
        { seq: after + 30, durationMs: 30_000, state: 'SILENT' },
      ],
    });
    expect(beatB).toMatchObject({ ok: true, capturing: true });
    expect(await prisma.liveAudioManifest.count({ where: { sessionId: w.ls.id } })).toBe(2);
    expect((await s.rtc.state(w.teacher.id, w.ls.id)).captureLease).toMatchObject({
      id: b.leaseId,
      mine: true,
    });
  });
});

describe('a piece delivered late is still owed', () => {
  it('after the class ended: taken when spoken inside a span, refused outside', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 40 * MIN;
    const { w } = await endedClass(s, { pieces: [], spanFrom: t0, spanTo: t0 + 20 * MIN });
    // The class ended twenty minutes ago — long past the old 45 s window.
    const inside = secOf(t0 + 5 * MIN);
    expect(await codeOf(s.live.storeAudioPiece(w.scope, w.ls.id, inside, file(inside)))).toBe('ok');
    const outside = secOf(t0 + 30 * MIN);
    expect(await codeOf(s.live.storeAudioPiece(w.scope, w.ls.id, outside, file(outside)))).toBe(
      'NOT_LIVE',
    );
    // And it reopened the transcript so a job will see it.
    expect(
      await prisma.aiJob.count({
        where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
      }),
    ).toBe(1);
  });
});

describe('READY means the lesson is covered', () => {
  it('complete coverage → READY', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 30 * MIN;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 9 * MIN,
      pieces: [0, 3, 6].map((m) => ({ atMs: t0 + 2_000 + m * MIN, lenMs: 3 * MIN })),
    });
    await queue(s, w);
    const row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    expect(metaOf(row).coverage).toMatchObject({ complete: true, gaps: [], missingPieces: 0 });
  });

  it('a piece the tab made never arrived → PARTIAL, then READY once it does', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 30 * MIN;
    const { w, run, lease } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 9 * MIN,
      pieces: [0, 6].map((m) => ({ atMs: t0 + 2_000 + m * MIN, lenMs: 3 * MIN })),
    });
    // The middle piece: made (the manifest says so), never delivered.
    const middle = secOf(t0 + 2_000 + 3 * MIN);
    await prisma.liveAudioManifest.create({
      data: {
        sessionId: w.ls.id,
        roomName: run,
        seq: middle,
        durationMs: 3 * MIN,
        state: 'QUEUED',
        leaseId: lease.id,
      },
    });
    await queue(s, w);
    let row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('PARTIAL');
    expect(metaOf(row).coverage).toMatchObject({ complete: false, missingPieces: 1 });
    expect(metaOf(row).coverage!.gaps.length).toBe(1);

    // It arrives (the page came back online): taken, the transcript reopened, and whole.
    expect(
      await codeOf(
        s.live.storeAudioPiece(w.scope, w.ls.id, middle, file(middle), 3 * MIN, {
          uploaderUserId: w.teacher.id,
          leaseId: lease.id,
        }),
      ),
    ).toBe('ok');
    row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    expect(row.transcriptText!.split('\n\n')).toEqual(
      [secOf(t0 + 2_000), middle, secOf(t0 + 2_000 + 6 * MIN)].map((q) => `words of ${q}`),
    );
  });

  it('a gap nobody accounted for → PARTIAL with the gap named', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 30 * MIN;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 9 * MIN,
      pieces: [0, 6].map((m) => ({ atMs: t0 + 2_000 + m * MIN, lenMs: 3 * MIN })),
    });
    await queue(s, w);
    const row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('PARTIAL');
    const gap = metaOf(row).coverage!.gaps[0];
    expect(gap.toSec - gap.fromSec).toBeGreaterThanOrEqual(170);
  });

  it('a long lecture: 60+ pieces, every one in order, READY', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 4 * 60 * MIN;
    const n = 64;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + n * MIN + 5_000,
      pieces: Array.from({ length: n }, (_, i) => ({ atMs: t0 + 2_000 + i * MIN, lenMs: MIN })),
    });
    await queue(s, w);
    const row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    const lines = row.transcriptText!.split('\n\n');
    expect(lines.length).toBe(n);
    const seqs = lines.map((l) => Number(l.replace('words of ', '')));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(metaOf(row).pieces).toBe(n);
  });
});

describe('a class reopened inside its window is one transcript', () => {
  it('both runs are transcribed and merged in order; the second never replaces the first', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 60 * MIN;
    const {
      w,
      run: run1,
      lease,
    } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 4 * MIN,
      pieces: [{ atMs: t0 + 2_000, lenMs: 3 * MIN + 50_000 }],
    });
    await queue(s, w);
    let row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    const first = row.transcriptText;

    // Reopened: a second run, its own span and piece.
    const run2 = `${run1}-run2`;
    const t1 = t0 + 20 * MIN;
    await prisma.liveSession.update({
      where: { id: w.ls.id },
      data: { roomName: run2, startedAt: new Date(t1 - 10_000), endedAt: new Date(t1 + 4 * MIN) },
    });
    await prisma.liveCaptureSpan.create({
      data: {
        sessionId: w.ls.id,
        roomName: run2,
        source: 'RECORDING',
        startedAt: new Date(t1),
        endedAt: new Date(t1 + 4 * MIN),
      },
    });
    const lease2 = await prisma.liveCaptureLease.create({
      data: { sessionId: w.ls.id, roomName: run2, userId: w.teacher.id, tabId: lease.tabId },
    });
    await putPiece(s, w, run2, secOf(t1 + 2_000), 3 * MIN + 50_000, lease2.id);
    // The second run ends: queued again even though the first is READY.
    await (s.live as any).queueTranscript(
      { id: w.ls.id, tenantId: w.tp.id, academyId: w.tp.id },
      run2,
    );
    row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    const lines = row.transcriptText!.split('\n\n');
    expect(lines).toEqual([first, `words of ${secOf(t1 + 2_000)}`]);
    expect(metaOf(row).runs).toBe(2);
    // The first run is not before second zero of the class.
    const segs = row.transcriptSegments as { startSec: number }[];
    expect(segs[0].startSec).toBeGreaterThanOrEqual(0);
    expect(segs[1].startSec).toBeGreaterThan(segs[0].startSec);
  });
});

describe('one job per class', () => {
  it('queueing twice (two ends, a late piece, a retry) is one job', async () => {
    if (!guard()) return;
    const s = stack();
    const t0 = Date.now() - 30 * MIN;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 3 * MIN,
      pieces: [{ atMs: t0 + 2_000, lenMs: 2 * MIN + 50_000 }],
    });
    const at = { id: w.ls.id, tenantId: w.tp.id, academyId: w.tp.id };
    await (s.live as any).queueTranscript(at, w.ls.roomName);
    await (s.live as any).queueTranscript(at, w.ls.roomName);
    await (s.live as any).reopenTranscript(at, w.ls.roomName, 'late-piece');
    expect(
      await prisma.aiJob.count({
        where: { type: 'LIVE_TRANSCRIBE', input: { path: ['liveSessionId'], equals: w.ls.id } },
      }),
    ).toBe(1);
  });
});

describe('the speech-to-text provider failing', () => {
  it('a transient failure is retried in the run and the transcript is whole', async () => {
    if (!guard()) return;
    let calls = 0;
    const flaky: SpeechToText = async (audio, f, o) => {
      if (calls++ === 0) throw new SttError('SERVER', '503');
      return echoStt(audio, f, o);
    };
    const s = stack(flaky);
    const t0 = Date.now() - 30 * MIN;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 3 * MIN,
      pieces: [{ atMs: t0 + 2_000, lenMs: 2 * MIN + 50_000 }],
    });
    await queue(s, w);
    const row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('READY');
    expect(calls).toBe(2);
  });

  it('an account refusal (no credits) stops at once: FAILED, audio kept, nothing more sent', async () => {
    if (!guard()) return;
    let calls = 0;
    const broke: SpeechToText = async () => {
      calls++;
      throw new SttError('ACCOUNT', '429 insufficient_quota');
    };
    const s = stack(broke);
    const t0 = Date.now() - 30 * MIN;
    const { w } = await endedClass(s, {
      spanFrom: t0,
      spanTo: t0 + 13 * MIN,
      pieces: [0, 3, 6, 9].map((m) => ({ atMs: t0 + 2_000 + m * MIN, lenMs: 3 * MIN })),
    });
    await queue(s, w);
    const row = await transcribe(s, w);
    expect(row.transcriptStatus).toBe('FAILED');
    expect(metaOf(row).reason).toBe('PROVIDER_UNAVAILABLE');
    // Only the calls already in flight (three at a time); nothing started after.
    expect(calls).toBeLessThanOrEqual(TRANSCRIBE_CONCURRENCY);
    expect(calls).toBeLessThan(4);
    expect(s.storage.objects.size).toBe(4);
  });
});
