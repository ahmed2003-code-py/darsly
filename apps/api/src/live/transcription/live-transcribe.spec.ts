import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { pipelineStages } from '../live-pipeline';
import { LiveService } from '../live.service';
import { dailyProviders } from '../providers/testing';
import { LiveTranscribeHandler } from './live-transcribe.handler';
import { audioKey, transcriptionConfig } from './lesson-transcription';

/**
 * B.8 — a Darsly-hosted lesson's transcript from the audio its teacher's page
 * captured. The speech-to-text call is a fake here: it is a paid call.
 */
type Piece = { id: string; sessionId: string; roomName: string; seq: number; key: string; sizeBytes: number; text: string | null };

function world(opts: { endedAgoMs?: number; pieces?: number } = {}) {
  const session = {
    id: 's1',
    endedAt: new Date(Date.now() - (opts.endedAgoMs ?? 120_000)),
    transcriptStatus: 'PROCESSING' as string,
    transcriptText: null as string | null,
  };
  const pieces: Piece[] = Array.from({ length: opts.pieces ?? 3 }, (_, i) => ({
    id: `p${i}`,
    sessionId: 's1',
    roomName: 'cf-room',
    // Stored out of order: the job must put them back in order.
    seq: [2, 0, 1][i] ?? i,
    key: audioKey('s1', 'cf-room', [2, 0, 1][i] ?? i),
    sizeBytes: 720_000,
    text: null,
  }));
  const objects = new Set(pieces.map((p) => p.key));
  const prisma = {
    liveSession: {
      findUnique: jest.fn(async () => ({ ...session })),
      update: jest.fn(async ({ data }: any) => Object.assign(session, data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.transcriptStatus && where.transcriptStatus !== session.transcriptStatus) return { count: 0 };
        Object.assign(session, data);
        return { count: 1 };
      }),
    },
    liveAudioSegment: {
      findMany: jest.fn(async () => [...pieces].sort((a, b) => a.seq - b.seq).map((p) => ({ ...p }))),
      update: jest.fn(async ({ where, data }: any) => Object.assign(pieces.find((p) => p.id === where.id)!, data)),
      deleteMany: jest.fn(async () => {
        pieces.length = 0;
        return { count: 0 };
      }),
    },
  };
  const storage = {
    getBuffer: jest.fn(async (key: string) => Buffer.from(key)),
    delete: jest.fn(async (key: string) => void objects.delete(key)),
  };
  const sleep = jest.fn(async () => undefined);
  return { session, pieces, objects, prisma, storage, sleep };
}

const job = { id: 'j1', input: { liveSessionId: 's1', roomName: 'cf-room' } } as any;

describe('LIVE_TRANSCRIBE', () => {
  it('transcribes the pieces in order, saves the transcript, and deletes the audio', async () => {
    const w = world();
    const stt = jest.fn(async (audio: Buffer) => `نص ${audio.toString().slice(-6, -5)}`);
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, stt, w.sleep);
    const r = await h.handle(job);
    expect(stt.mock.calls.map((c) => c[0].toString())).toEqual([
      audioKey('s1', 'cf-room', 0),
      audioKey('s1', 'cf-room', 1),
      audioKey('s1', 'cf-room', 2),
    ]);
    expect(w.session.transcriptStatus).toBe('READY');
    expect(w.session.transcriptText).toBe('نص 0\nنص 1\nنص 2');
    expect(w.objects.size).toBe(0);
    expect(w.pieces).toHaveLength(0);
    expect(r).toEqual({ costCents: expect.any(Number) });
    expect(w.sleep).not.toHaveBeenCalled();
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
    expect(w.pieces.find((p) => p.seq === 0)!.text).toBe('t1');
    expect(w.session.transcriptStatus).toBe('PROCESSING');
    await h.handle(job);
    expect(flaky).toHaveBeenCalledTimes(4); // 1 ok, 1 failed, then only the 2 left
    expect(w.session.transcriptText).toBe('t1\nt3\nt4');
  });

  it('the queue\'s last try marks the transcript failed instead of leaving it "transcribing"', async () => {
    const w = world();
    const down = async () => {
      throw new AiJobError('Transcription unreachable: TimeoutError', 'RETRYABLE');
    };
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, down, w.sleep);
    await expect(h.handle({ ...job, attempts: 1 })).rejects.toThrow();
    expect(w.session.transcriptStatus).toBe('PROCESSING');
    await expect(h.handle({ ...job, attempts: 3 })).rejects.toThrow();
    expect(w.session.transcriptStatus).toBe('FAILED');
  });

  it('a refused request fails the transcript for good', async () => {
    const w = world();
    const refused = async () => {
      throw new AiJobError('Transcription refused (400)', 'TERMINAL');
    };
    const h = new LiveTranscribeHandler(w.prisma as any, w.storage as any, refused, w.sleep);
    await expect(h.handle(job)).rejects.toMatchObject({ errorClass: 'TERMINAL' });
    expect(w.session.transcriptStatus).toBe('FAILED');
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
});

describe('transcription switch', () => {
  it('is off unless switched on AND a key exists', () => {
    expect(transcriptionConfig({}).enabled).toBe(false);
    expect(transcriptionConfig({ LIVE_TRANSCRIPTION_ENABLED: 'true' }).enabled).toBe(false);
    expect(transcriptionConfig({ OPENAI_API_KEY: 'k' }).enabled).toBe(false);
    const on = transcriptionConfig({ LIVE_TRANSCRIPTION_ENABLED: 'true', OPENAI_API_KEY: 'k' });
    expect(on).toMatchObject({ enabled: true, model: 'gpt-4o-mini-transcribe' });
  });

  it('a Cloudflare lesson being transcribed shows TRANSCRIBING, even while its recording is processing', () => {
    const s = pipelineStages({
      provider: 'CLOUDFLARE',
      transcriptStatus: 'PROCESSING',
      hasTranscriptText: false,
      summaryStatus: 'NOT_STARTED',
      summaryError: null,
      recordingStage: 'PROCESSING',
    });
    expect(s.transcript.stage).toBe('TRANSCRIBING');
    expect(s.summary).toEqual({ stage: 'WAITING_FOR_TRANSCRIPT', canGenerate: false });
  });
});

describe('the lesson-audio upload', () => {
  const scope = { academyId: 'a1', userId: 't1', manageAll: false, role: 'TEACHER' };
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  function setup(session: Record<string, unknown>) {
    const rows: any[] = [];
    const prisma = {
      liveSession: { findFirst: jest.fn(async () => session) },
      liveAudioSegment: {
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const k = where.sessionId_roomName_seq;
          const hit = rows.find((r) => r.seq === k.seq);
          if (hit) Object.assign(hit, update);
          else rows.push({ ...create });
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
  const file = { buffer: Buffer.from('opus'), size: 4, mimetype: 'audio/webm;codecs=opus' };
  const T = Math.floor(Date.now() / 1000);

  it('is refused while transcription is switched off', async () => {
    delete process.env.LIVE_TRANSCRIPTION_ENABLED;
    const { svc, storage } = setup(live);
    await expect(svc.storeAudioPiece(scope, 's1', T, file)).rejects.toMatchObject({
      response: { code: 'TRANSCRIPTION_OFF' },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  describe('switched on', () => {
    beforeEach(() => {
      process.env.LIVE_TRANSCRIPTION_ENABLED = 'true';
      process.env.OPENAI_API_KEY = 'test-key';
    });

    it('stores a piece of a live class privately, and a retried piece replaces itself', async () => {
      const { svc, rows, storage } = setup(live);
      await svc.storeAudioPiece(scope, 's1', T, file);
      await svc.storeAudioPiece(scope, 's1', T, { ...file, buffer: Buffer.from('opus2'), size: 5 });
      expect(rows).toEqual([expect.objectContaining({ seq: T, sizeBytes: 5, key: audioKey('s1', 'cf-room', T) })]);
      // Safari's MP4 keeps its own extension: the transcriber reads the format from it.
      await svc.storeAudioPiece(scope, 's1', T + 180, { ...file, mimetype: 'audio/mp4' });
      expect(rows[1].key).toBe(audioKey('s1', 'cf-room', T + 180, 'm4a'));
      expect((storage.put.mock.calls[0] as any[])[0]).toMatch(/^source\/live-audio\//);
    });

    it('takes the last piece just after the end, and nothing later', async () => {
      const justEnded = { ...live, status: 'ENDED', endedAt: new Date(Date.now() - 5_000) };
      await expect(setup(justEnded).svc.storeAudioPiece(scope, 's1', T, file)).resolves.toMatchObject({ ok: true });
      const longAgo = { ...live, status: 'ENDED', endedAt: new Date(Date.now() - 10 * 60_000) };
      await expect(setup(longAgo).svc.storeAudioPiece(scope, 's1', T, file)).rejects.toMatchObject({
        response: { code: 'NOT_LIVE' },
      });
    });

    it('refuses a Daily class, a bad piece number and an empty file', async () => {
      await expect(
        setup({ ...live, provider: 'DAILY' }).svc.storeAudioPiece(scope, 's1', T, file),
      ).rejects.toMatchObject({ response: { code: 'NOT_CLOUDFLARE' } });
      await expect(setup(live).svc.storeAudioPiece(scope, 's1', 7, file)).rejects.toMatchObject({
        response: { code: 'BAD_SEQ' },
      });
      await expect(setup(live).svc.storeAudioPiece(scope, 's1', T, undefined)).rejects.toMatchObject({
        response: { code: 'EMPTY_AUDIO' },
      });
    });

    it("someone else's class is not found", async () => {
      await expect(setup(null as any).svc.storeAudioPiece(scope, 's1', T, file)).rejects.toThrow(
        'Session not found',
      );
    });
  });
});
