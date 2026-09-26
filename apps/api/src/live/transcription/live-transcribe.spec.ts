import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { LiveService } from '../live.service';
import { dailyProviders } from '../providers/testing';
import { LiveTranscribeHandler } from './live-transcribe.handler';
import {
  assembleTranscript,
  audioKey,
  captureActive,
  sniffAudio,
  transcriptionConfig,
} from './lesson-transcription';

/**
 * B.8 + Checkpoint C — a Darsly-hosted lesson's transcript from the audio its
 * teacher's page captured. The speech-to-text call is a fake here: it is a
 * paid call.
 */
type Piece = {
  id: string;
  sessionId: string;
  roomName: string;
  seq: number;
  key: string;
  sizeBytes: number;
  durationMs: number | null;
  text: string | null;
  error: string | null;
};

const START = 1_790_000_000; // the class's start, in Unix seconds

function world(opts: { endedAgoMs?: number; pieces?: number } = {}) {
  const session = {
    id: 's1',
    title: 'Neural networks',
    startedAt: new Date(START * 1000),
    endedAt: new Date(Date.now() - (opts.endedAgoMs ?? 120_000)),
    transcriptStatus: 'PROCESSING' as string,
    transcriptText: null as string | null,
    transcriptSegments: null as unknown,
    transcriptMeta: null as any,
  };
  // Stored out of order: the job must put them back in the order spoken.
  const order = [2, 0, 1];
  const pieces: Piece[] = Array.from({ length: opts.pieces ?? 3 }, (_, i) => {
    const n = order[i] ?? i;
    return {
      id: `p${n}`,
      sessionId: 's1',
      roomName: 'cf-room',
      seq: START + n * 180,
      key: audioKey('s1', 'cf-room', START + n * 180),
      sizeBytes: 720_000,
      durationMs: 180_000,
      text: null,
      error: null,
    };
  });
  const objects = new Set(pieces.map((p) => p.key));
  const calls: any[] = [];
  const sorted = () => [...pieces].sort((a, b) => a.seq - b.seq).map((p) => ({ ...p }));
  const prisma = {
    liveSession: {
      findUnique: jest.fn(async () => ({ ...session })),
      update: jest.fn(async ({ data }: any) =>
        Object.assign(session, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.transcriptStatus && where.transcriptStatus !== session.transcriptStatus) return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    liveAudioSegment: {
      findMany: jest.fn(async () => sorted()),
      update: jest.fn(async ({ where, data }: any) => Object.assign(pieces.find((p) => p.id === where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let n = 0;
        for (const p of pieces) {
          if (p.text === null && p.error === null && where.text === null) {
            Object.assign(p, data);
            n++;
          }
        }
        return { count: n };
      }),
      deleteMany: jest.fn(async () => {
        pieces.length = 0;
        return { count: 0 };
      }),
    },
    aiCallLog: { create: jest.fn(async ({ data }: any) => void calls.push(data)) },
  };
  const storage = {
    getBuffer: jest.fn(async (key: string) => Buffer.from(key)),
    delete: jest.fn(async (key: string) => void objects.delete(key)),
  };
  const sleep = jest.fn(async () => undefined);
  return { session, pieces, objects, prisma, storage, sleep, calls };
}

const job = { id: 'j1', attempts: 1, input: { liveSessionId: 's1', roomName: 'cf-room' } } as any;
/** Which piece a fake STT call was given: the piece's number of 180 s steps. */
const pieceOf = (audio: Buffer) => (Number(audio.toString().match(/(\d+)\.webm$/)![1]) - START) / 180;

describe('LIVE_TRANSCRIBE', () => {
  it('transcribes the pieces in the order spoken, with timestamps, and deletes the audio', async () => {
    const w = world();
    const stt = jest.fn(async (audio: Buffer, _name: string, _opts?: { prompt?: string }) => `نص ${pieceOf(audio)}`);
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, stt, w.sleep);
    const r = await h.handle(job);
    expect(stt.mock.calls.map((c) => pieceOf(c[0]))).toEqual([0, 1, 2]);
    // The lesson title goes with every piece (it helps the model with its terms).
    expect(stt.mock.calls[0][2]).toEqual({ prompt: 'Neural networks' });
    expect(w.session.transcriptStatus).toBe('READY');
    expect(w.session.transcriptText).toBe('نص 0\n\nنص 1\n\nنص 2');
    expect(w.session.transcriptSegments).toEqual([
      { startSec: 0, durationSec: 180, text: 'نص 0' },
      { startSec: 180, durationSec: 180, text: 'نص 1' },
      { startSec: 360, durationSec: 180, text: 'نص 2' },
    ]);
    expect(w.session.transcriptMeta).toMatchObject({ pieces: 3, failed: 0, partial: false, audioSeconds: 540 });
    expect(w.objects.size).toBe(0);
    expect(w.pieces).toHaveLength(0);
    // 9 minutes at the mini model's list price: 2.7¢ → 3¢ toward the budget.
    expect(r).toEqual({ costCents: 3 });
    expect(w.sleep).not.toHaveBeenCalled();
  });

  it('records every call against the lesson and the job, without the words', async () => {
    const w = world({ pieces: 1 });
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, async () => 'secret words', w.sleep);
    await h.handle(job);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      stage: 'LIVE_TRANSCRIBE',
      model: 'gpt-4o-mini-transcribe',
      status: 'ok',
      liveSessionId: 's1',
      aiJobId: 'j1',
      costMillicents: 900, // 3 min × $0.003
    });
    expect(JSON.stringify(w.calls[0])).not.toContain('secret words');
  });

  it('waits for the last piece when the class has only just ended', async () => {
    const w = world({ endedAgoMs: 5_000 });
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, async () => 'x', w.sleep);
    await h.handle(job);
    expect(w.sleep).toHaveBeenCalledTimes(1);
    expect((w.sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(30_000);
  });

  it('a retry does not pay again for pieces already transcribed', async () => {
    const w = world();
    let calls = 0;
    const flaky = jest.fn(async () => {
      calls += 1;
      if (calls === 2) throw new AiJobError('Transcription refused (503)', 'RETRYABLE');
      return `t${calls}`;
    });
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, flaky, w.sleep);
    await expect(h.handle(job)).rejects.toThrow('503');
    // The first piece's words were kept; the class is still being transcribed.
    expect(w.pieces.find((p) => p.id === 'p0')!.text).toBe('t1');
    expect(w.session.transcriptStatus).toBe('PROCESSING');
    await h.handle({ ...job, attempts: 2 });
    expect(flaky).toHaveBeenCalledTimes(4); // 1 ok, 1 failed, then only the 2 left
    expect(w.session.transcriptText).toBe('t1\n\nt3\n\nt4');
  });

  it('one piece refused for good does not sink the lesson: the transcript is partial', async () => {
    const w = world();
    const stt = async (audio: Buffer) => {
      if (pieceOf(audio) === 1) throw new AiJobError('Transcription refused (400): bad audio', 'TERMINAL');
      return `ok ${pieceOf(audio)}`;
    };
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, stt, w.sleep);
    await h.handle(job);
    expect(w.session.transcriptStatus).toBe('READY');
    expect(w.session.transcriptText).toBe('ok 0\n\nok 2');
    expect(w.session.transcriptMeta).toMatchObject({ failed: 1, partial: true });
    expect(w.calls.map((c) => c.status)).toEqual(['ok', 'failed', 'ok']);
  });

  it("the queue's last try gives up what is owed and keeps what was saved", async () => {
    const w = world();
    let n = 0;
    const down = async () => {
      n += 1;
      if (n === 1) return 'first';
      throw new AiJobError('Transcription unreachable: TimeoutError', 'RETRYABLE');
    };
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, down, w.sleep);
    await expect(h.handle({ ...job, attempts: 1 })).rejects.toThrow();
    expect(w.session.transcriptStatus).toBe('PROCESSING');
    await h.handle({ ...job, attempts: 3 });
    expect(w.session.transcriptStatus).toBe('READY');
    expect(w.session.transcriptText).toBe('first');
    expect(w.session.transcriptMeta).toMatchObject({ partial: true, failed: 2 });
  });

  it('nothing but refusals is a failed transcript, not "processing"', async () => {
    const w = world();
    const refused = async () => {
      throw new AiJobError('Transcription refused (400)', 'TERMINAL');
    };
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, refused, w.sleep);
    await expect(h.handle(job)).rejects.toMatchObject({ errorClass: 'TERMINAL' });
    expect(w.session.transcriptStatus).toBe('FAILED');
    // …and its audio is gone all the same.
    expect(w.objects.size).toBe(0);
  });

  it('a class with no audio costs nothing and goes back to "no transcript"', async () => {
    const w = world({ pieces: 0 });
    const stt = jest.fn();
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, stt, w.sleep);
    await h.handle(job);
    expect(stt).not.toHaveBeenCalled();
    expect(w.session.transcriptStatus).toBe('NOT_STARTED');
  });

  it('silence is not a transcript', async () => {
    const w = world();
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, async () => '', w.sleep);
    await expect(h.handle(job)).rejects.toMatchObject({ errorClass: 'TERMINAL' });
    expect(w.session.transcriptStatus).toBe('FAILED');
  });

  it('an already-finished transcript is never paid for again', async () => {
    const w = world();
    w.session.transcriptStatus = 'READY';
    const stt = jest.fn();
    await new LiveTranscribeHandler(w.prisma as any, w.storage as any, stt, w.sleep).handle(job);
    expect(stt).not.toHaveBeenCalled();
  });
});

describe('assembly', () => {
  it('is ordered by when it was said, not when it arrived, and leaves gaps where nothing was', () => {
    const out = assembleTranscript(
      [
        { seq: START + 600, durationMs: 180_000, text: 'c' },
        { seq: START, durationMs: 180_000, text: 'a' },
        { seq: START + 180, durationMs: 180_000, text: '' }, // silence
        { seq: START + 360, durationMs: null, text: null }, // failed
      ],
      START,
    );
    expect(out.segments.map((s) => [s.startSec, s.text])).toEqual([
      [0, 'a'],
      [600, 'c'],
    ]);
    expect(out.text).toBe('a\n\nc');
    // The same input, the same transcript.
    expect(assembleTranscript([...[{ seq: START, durationMs: 1, text: 'a' }]], START)).toEqual(
      assembleTranscript([{ seq: START, durationMs: 1, text: 'a' }], START),
    );
  });
});

describe('modes and switches', () => {
  it('is off unless switched on AND a key exists; new classes take the default mode', () => {
    expect(transcriptionConfig({}).enabled).toBe(false);
    expect(transcriptionConfig({ LIVE_TRANSCRIPTION_ENABLED: 'true' }).enabled).toBe(false);
    expect(transcriptionConfig({ OPENAI_API_KEY: 'k' }).enabled).toBe(false);
    const on = transcriptionConfig({ LIVE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'k' });
    expect(on).toMatchObject({ enabled: true, model: 'gpt-4o-mini-transcribe', defaultMode: 'AUTO_WHEN_RECORDING' });
    expect(transcriptionConfig({ LIVE_TRANSCRIPTION_DEFAULT_MODE: 'manual' }).defaultMode).toBe('MANUAL');
    expect(transcriptionConfig({ LIVE_TRANSCRIPTION_DEFAULT_MODE: 'nonsense' }).defaultMode).toBe(
      'AUTO_WHEN_RECORDING',
    );
  });

  it('OFF never captures; AUTO follows the recording; MANUAL follows the teacher', () => {
    const t = (ms: number) => new Date(1_000_000 + ms);
    const base = { enabled: true, captureOnAt: null, captureOffAt: null, recording: false };
    expect(captureActive({ ...base, mode: 'OFF', recording: true })).toBe(false);
    expect(captureActive({ ...base, mode: 'AUTO_WHEN_RECORDING', recording: true })).toBe(true);
    expect(captureActive({ ...base, mode: 'AUTO_WHEN_RECORDING', recording: false })).toBe(false);
    // Recording is not transcription: MANUAL ignores it.
    expect(captureActive({ ...base, mode: 'MANUAL', recording: true })).toBe(false);
    expect(captureActive({ ...base, mode: 'MANUAL', captureOnAt: t(1) })).toBe(true);
    expect(captureActive({ ...base, mode: 'MANUAL', captureOnAt: t(1), captureOffAt: t(2) })).toBe(false);
    expect(captureActive({ ...base, mode: 'MANUAL', captureOnAt: t(3), captureOffAt: t(2) })).toBe(true);
    // The global switch wins over everything.
    expect(captureActive({ ...base, enabled: false, mode: 'AUTO_WHEN_RECORDING', recording: true })).toBe(false);
  });

  it('reads what the bytes are, not what the upload claims', () => {
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('webm');
    expect(sniffAudio(Buffer.from('\0\0\0\x20ftypM4A ', 'latin1'))).toBe('m4a');
    expect(sniffAudio(Buffer.from('<html>not audio</html>'))).toBeNull();
  });
});

describe('the lesson-audio upload', () => {
  const scope = { academyId: 'a1', userId: 't1', manageAll: false, role: 'TEACHER' };
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  const webm = (n = 4000) => {
    const b = Buffer.alloc(n);
    b.writeUInt32BE(0x1a45dfa3, 0);
    return b;
  };
  function setup(
    session: Record<string, unknown> | null,
    opts: { mode?: string; onAt?: Date | null; offAt?: Date | null; recording?: any; recent?: number } = {},
  ) {
    const rows: any[] = [];
    const prisma = {
      liveSession: {
        findFirst: jest.fn(async () => session),
        findUnique: jest.fn(async () => ({
          transcriptionMode: opts.mode ?? 'AUTO_WHEN_RECORDING',
          transcriptCaptureOnAt: opts.onAt ?? null,
          transcriptCaptureOffAt: opts.offAt ?? null,
        })),
      },
      liveRecording: {
        findFirst: jest.fn(async () =>
          opts.recording === undefined
            ? { status: 'RECORDING', stopRequestedAt: null, stoppedAt: null }
            : opts.recording,
        ),
      },
      liveAudioSegment: {
        findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.seq === where.sessionId_roomName_seq.seq) ?? null),
        count: jest.fn(async () => opts.recent ?? 0),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const hit = rows.find((r) => r.seq === where.sessionId_roomName_seq.seq);
          if (hit) Object.assign(hit, update);
          else rows.push({ ...create, text: null });
        }),
      },
    };
    const storage = { put: jest.fn(async () => undefined) };
    const svc = new LiveService(
      prisma as any, {} as any, {} as any, dailyProviders({}), {} as any, {} as any, {} as any,
      storage as any,
    );
    return { svc, rows, storage, prisma };
  }
  const live = { id: 's1', provider: 'CLOUDFLARE', roomName: 'cf-room', status: 'LIVE', endedAt: null };
  const file = (b = webm(), mimetype = 'audio/webm;codecs=opus') => ({ buffer: b, size: b.length, mimetype });
  const T = () => Math.floor(Date.now() / 1000);
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e?.response?.code ?? e?.message);

  it('is refused while transcription is switched off', async () => {
    delete process.env.LIVE_TRANSCRIPTION_ENABLED;
    const { svc, storage } = setup(live);
    expect(await code(svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('TRANSCRIPTION_OFF');
    expect(storage.put).not.toHaveBeenCalled();
  });

  describe('switched on', () => {
    beforeEach(() => {
      process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
      process.env.OPENAI_API_KEY = 'test-key';
    });

    it('stores a piece privately; the same piece again is a no-op, never a second charge', async () => {
      const { svc, rows, storage } = setup(live);
      const t = T();
      await svc.storeAudioPiece(scope, 's1', t, file(), 180_000);
      expect(await svc.storeAudioPiece(scope, 's1', t, file(), 180_000)).toMatchObject({ duplicate: true });
      expect(rows).toEqual([
        expect.objectContaining({ seq: t, sizeBytes: 4000, durationMs: 180_000, key: audioKey('s1', 'cf-room', t) }),
      ]);
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect((storage.put.mock.calls[0] as any[])[0]).toMatch(/^source\/live-audio\//);
      // Already transcribed: a different upload for that second is ignored too.
      rows[0].text = 'words';
      expect(await svc.storeAudioPiece(scope, 's1', t, file(webm(5000)))).toMatchObject({ duplicate: true });
      expect(rows[0].sizeBytes).toBe(4000);
    });

    it("Safari's MP4 is kept as .m4a — the header decides, not the name", async () => {
      const { svc, rows } = setup(live);
      const mp4 = Buffer.concat([Buffer.from('\0\0\0\x20ftypM4A ', 'latin1'), Buffer.alloc(4000)]);
      await svc.storeAudioPiece(scope, 's1', T(), file(mp4, 'audio/mp4'));
      expect(rows[0].key).toMatch(/\.m4a$/);
    });

    it('refuses what is not audio, whatever it says it is', async () => {
      const { svc } = setup(live);
      const html = Buffer.from('<html>'.padEnd(4000, 'x'));
      expect(await code(svc.storeAudioPiece(scope, 's1', T(), file(html)))).toBe('BAD_AUDIO');
      expect(await code(svc.storeAudioPiece(scope, 's1', T(), file(webm(), 'text/html')))).toBe('BAD_AUDIO');
      expect(await code(svc.storeAudioPiece(scope, 's1', T(), file(webm(50))))).toBe('EMPTY_AUDIO');
    });

    it('refuses a flood of pieces', async () => {
      const { svc } = setup(live, { recent: 8 });
      expect(await code(svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('AUDIO_RATE');
    });

    it('OFF mode, and capture that is off, take nothing', async () => {
      expect(await code(setup(live, { mode: 'OFF' }).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe(
        'CAPTURE_OFF',
      );
      // AUTO with no recording running.
      expect(await code(setup(live, { recording: null }).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe(
        'CAPTURE_OFF',
      );
      // MANUAL, never switched on.
      expect(await code(setup(live, { mode: 'MANUAL' }).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe(
        'CAPTURE_OFF',
      );
      // MANUAL, switched on.
      expect(
        await code(setup(live, { mode: 'MANUAL', onAt: new Date() }).svc.storeAudioPiece(scope, 's1', T(), file())),
      ).toBe('ok');
    });

    it('takes the piece flushed just after capture stopped, and nothing much later', async () => {
      const stopped = (ago: number) => ({
        recording: { status: 'UPLOADING', stopRequestedAt: new Date(Date.now() - ago), stoppedAt: null },
      });
      expect(await code(setup(live, stopped(5_000)).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('ok');
      expect(await code(setup(live, stopped(10 * 60_000)).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe(
        'CAPTURE_OFF',
      );
    });

    it('takes the last piece just after the end, and nothing later', async () => {
      const justEnded = { ...live, status: 'ENDED', endedAt: new Date(Date.now() - 5_000) };
      expect(await code(setup(justEnded).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('ok');
      const longAgo = { ...live, status: 'ENDED', endedAt: new Date(Date.now() - 10 * 60_000) };
      expect(await code(setup(longAgo).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('NOT_LIVE');
    });

    it('refuses a Daily class, a bad piece number and an empty file', async () => {
      expect(await code(setup({ ...live, provider: 'DAILY' }).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe(
        'NOT_CLOUDFLARE',
      );
      expect(await code(setup(live).svc.storeAudioPiece(scope, 's1', 7, file()))).toBe('BAD_SEQ');
      expect(await code(setup(live).svc.storeAudioPiece(scope, 's1', T(), undefined))).toBe('EMPTY_AUDIO');
    });

    it("someone else's class is not found", async () => {
      expect(await code(setup(null).svc.storeAudioPiece(scope, 's1', T(), file()))).toBe('Session not found');
    });
  });
});
