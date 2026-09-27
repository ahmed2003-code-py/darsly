import { Logger } from '@nestjs/common';
import { AiJob, AiJobType, LiveAudioSegment } from '@prisma/client';
import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { AiJobHandler, AiJobResult } from '../../academy-site/jobs/ai-job.handler';
import { maxAttemptsFor } from '../../academy-site/jobs/ai-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import {
  LAST_PIECE_GRACE_MS,
  openAiSpeechToText,
  sttUsdPerMin,
  transcriptionConfig,
  type SpeechToText,
} from './lesson-transcription';
import { estimateMs, isPromptEcho, isTooShort, looksLikeRepetitionLoop, retryDelayFor } from './stt-guards';
import { finalizeTranscript, type TranscriptChanged } from './transcript-assembly';

/** How long one owner holds a class before another job may take over. Renewed before every piece. */
export const TRANSCRIPT_LEASE_MS = 4 * 60_000;
/** After the upload window closes, a moment for the last upload's row to land. */
const UPLOAD_SETTLE_MS = 5_000;
/** An echo of the title on a piece this short is silence; on a longer one it is lost speech. */
const ECHO_IS_SILENCE_BELOW_MS = 10_000;
/** New pieces appearing while the job works are picked up, a bounded number of times. */
const MAX_ROUNDS = 5;

type PieceOutcome = 'done' | 'skipped' | 'failed' | { retry: string };

/**
 * The LIVE_TRANSCRIBE job: a finished Darsly-hosted class's audio pieces, in
 * the order spoken, into one transcript on the class.
 *
 *  - One owner per class. The job claims a lease on the session and renews it
 *    before every piece; a second job (duplicate delivery, a lease reclaimed
 *    from a stalled worker) finds it held and steps aside, and a stalled owner
 *    that lost it stops before paying for another piece.
 *  - Each piece's words are saved on its row the moment they arrive, and only
 *    then is that piece's audio deleted. A piece that failed keeps its audio
 *    (for a retry, until the retention window ends).
 *  - A retryable failure (outage, 429/5xx, a repetition loop in the answer)
 *    leaves the class PROCESSING and asks the queue to try again later
 *    (≈1, 5, 15 min). Only after the last attempt are the pieces still owed
 *    marked failed — and then the transcript is PARTIAL, never READY.
 *  - A piece under 2 s is never sent; an answer that is just the lesson title
 *    is not taken as speech (see stt-guards.ts).
 *
 * The class's state is decided by finalizeTranscript (READY / PARTIAL /
 * FAILED), which also queues the summary when the words changed.
 */
export class LiveTranscribeHandler implements AiJobHandler {
  readonly type: AiJobType = 'LIVE_TRANSCRIBE';
  private readonly logger = new Logger(LiveTranscribeHandler.name);
  private readonly stt: SpeechToText;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    stt?: SpeechToText,
    /** Replaceable in tests. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Told when the words changed (queues the summary); a no-op in tests that do not care. */
    private readonly onChanged: TranscriptChanged = async () => undefined,
  ) {
    this.stt = stt ?? openAiSpeechToText();
  }

  async handle(job: AiJob): Promise<AiJobResult | void> {
    const { liveSessionId, roomName } = (job.input ?? {}) as { liveSessionId?: string; roomName?: string };
    if (!liveSessionId || !roomName) throw new AiJobError('No session on job', 'TERMINAL');
    const session = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: { id: true, title: true, endedAt: true },
    });
    if (!session) throw new AiJobError('Session no longer exists', 'TERMINAL');

    // Pieces are accepted until LAST_PIECE_GRACE_MS after the end: start only
    // once that window has closed, so nothing can arrive behind the job.
    const since = session.endedAt ? Date.now() - session.endedAt.getTime() : 0;
    const wait = LAST_PIECE_GRACE_MS + UPLOAD_SETTLE_MS - since;
    if (wait > 0) await this.sleep(wait);

    if (!(await this.claim(job.id, liveSessionId))) {
      this.logger.log(`live.transcript.not-owner liveSession=${liveSessionId} job=${job.id}`);
      return;
    }
    if (!(await this.prisma.liveAudioSegment.count({ where: { sessionId: liveSessionId, roomName } }))) {
      // Nothing was captured (capture never ran, or nobody spoke long enough
      // for a piece): no transcript, and nothing paid for.
      await this.prisma.liveSession.updateMany({
        where: { id: liveSessionId, transcriptStatus: 'PROCESSING' },
        data: { transcriptStatus: 'NOT_STARTED' },
      });
      await this.release(job.id, liveSessionId);
      this.logger.log(`live.transcript.nothing-captured liveSession=${liveSessionId} job=${job.id}`);
      return;
    }
    const cfg = transcriptionConfig();
    const lastTry = job.attempts >= maxAttemptsFor(job.type);
    let paidMs = 0;
    try {
      let retry: string | null = null;
      for (let round = 0; round < MAX_ROUNDS && !retry; round++) {
        const pending = await this.prisma.liveAudioSegment.findMany({
          where: { sessionId: liveSessionId, roomName, text: null, error: null },
          orderBy: { seq: 'asc' },
        });
        if (!pending.length) break;
        for (const p of pending) {
          // Lost the class to another job: stop before paying for anything else.
          if (!(await this.claim(job.id, liveSessionId))) return;
          const out = await this.piece(job, p, session.title, cfg.model, lastTry);
          if (out === 'done' || out === 'failed') paidMs += estimateMs(p);
          if (typeof out === 'object') {
            retry = out.retry;
            break;
          }
        }
      }
      if (retry && !lastTry) {
        // Everything saved so far stays saved; the rest is tried again later.
        const delay = retryDelayFor(job.attempts);
        this.logger.warn(
          `live.transcript.retry-later liveSession=${liveSessionId} job=${job.id} attempt=${job.attempts} inMs=${delay}: ${retry}`,
        );
        throw new AiJobError(`Transcription will be retried: ${retry}`, 'RETRYABLE', undefined, delay);
      }
      const out = await finalizeTranscript(this.prisma, {
        sessionId: liveSessionId,
        roomName,
        jobId: job.id,
        model: cfg.model,
        giveUpPending: lastTry,
        onChanged: this.onChanged,
      });
      const usd = (paidMs / 60_000) * sttUsdPerMin(cfg.model);
      this.logger.log(
        `live.transcript.${out.status.toLowerCase()} liveSession=${liveSessionId} job=${job.id} ` +
          `pieces=${out.meta.pieces} failed=${out.meta.failed} skipped=${out.meta.skipped} ` +
          `paidSec=${Math.round(paidMs / 1000)} estUsd=${usd.toFixed(4)} model=${cfg.model}`,
      );
      if (out.status === 'PENDING') {
        throw new AiJobError('New audio arrived while finishing; trying again', 'RETRYABLE', undefined, retryDelayFor(1));
      }
      return { costCents: Math.ceil(usd * 100) };
    } finally {
      await this.release(job.id, liveSessionId);
    }
  }

  /** Take or renew this class's lease — only if free, expired, or already ours. */
  private async claim(jobId: string, sessionId: string): Promise<boolean> {
    const now = new Date();
    const r = await this.prisma.liveSession.updateMany({
      where: {
        id: sessionId,
        OR: [
          { transcriptLeaseJobId: null },
          { transcriptLeaseJobId: jobId },
          { transcriptLeaseUntil: { lt: now } },
        ],
      },
      data: { transcriptLeaseJobId: jobId, transcriptLeaseUntil: new Date(now.getTime() + TRANSCRIPT_LEASE_MS) },
    });
    return r.count === 1;
  }

  private release(jobId: string, sessionId: string) {
    return this.prisma.liveSession
      .updateMany({
        where: { id: sessionId, transcriptLeaseJobId: jobId },
        data: { transcriptLeaseJobId: null, transcriptLeaseUntil: null },
      })
      .catch(() => undefined);
  }

  /** One piece → its words (saved, then its audio deleted), a skip, a failure, or "try later". */
  private async piece(job: AiJob, p: LiveAudioSegment, title: string, model: string, lastTry: boolean): Promise<PieceOutcome> {
    const ms = estimateMs(p);
    if (isTooShort(p)) {
      await this.saveWords(p, '', 'TOO_SHORT');
      return 'skipped';
    }
    let audio: Buffer;
    try {
      audio = await this.storage.getBuffer(p.key);
    } catch (e) {
      // The audio is gone (swept, or never stored): nothing to transcribe, ever.
      await this.fail(p, `AUDIO_MISSING: ${(e as Error).message.slice(0, 150)}`);
      return 'failed';
    }
    await this.prisma.liveAudioSegment.update({ where: { id: p.id }, data: { attempts: { increment: 1 } } });
    const t0 = Date.now();
    let status = 'ok';
    let error: string | null = null;
    try {
      const text = await this.stt(audio, `${p.seq}.${p.key.split('.').pop() ?? 'webm'}`, { prompt: title });
      if (isPromptEcho(text, title, ms)) {
        if (ms < ECHO_IS_SILENCE_BELOW_MS) {
          status = 'echo-skipped';
          await this.saveWords(p, '', 'PROMPT_ECHO');
          return 'skipped';
        }
        // A long piece answered with the title: the speech in it was lost.
        status = 'echo';
        return this.retryOrFail(p, 'PROMPT_ECHO: the answer was the lesson title', lastTry);
      }
      if (looksLikeRepetitionLoop(text, ms)) {
        status = 'loop';
        return this.retryOrFail(p, 'REPETITION_LOOP: the answer repeated itself', lastTry);
      }
      await this.saveWords(p, text, null);
      this.logger.log(
        `live.transcript.segment-ready liveSession=${p.sessionId} seq=${p.seq} audioSec=${Math.round(ms / 1000)} ms=${Date.now() - t0}`,
      );
      return 'done';
    } catch (e) {
      status = 'failed';
      error = (e as Error).message.slice(0, 300);
      if (e instanceof AiJobError && e.errorClass === 'TERMINAL') {
        // Refused for good (bad audio): this piece alone; the rest go on.
        await this.fail(p, error);
        return 'failed';
      }
      return this.retryOrFail(p, error, lastTry);
    } finally {
      // Every provider call is recorded — never the words. A refused call may
      // still be billed; an answer we rejected (echo, loop) certainly was.
      await this.prisma.aiCallLog
        .create({
          data: {
            stage: 'LIVE_TRANSCRIBE',
            model,
            startedAt: new Date(t0),
            latencyMs: Date.now() - t0,
            status,
            error,
            costMillicents: status === 'failed' ? 0 : Math.round((ms / 60_000) * sttUsdPerMin(model) * 100_000),
            liveSessionId: p.sessionId,
            aiJobId: job.id,
            meta: { seq: p.seq, audioSec: Math.round(ms / 1000), bytes: p.sizeBytes, attempt: p.attempts + 1 },
          },
        })
        .catch((err) => this.logger.warn(`AiCallLog write failed: ${(err as Error).message}`));
    }
  }

  private async retryOrFail(p: LiveAudioSegment, why: string, lastTry: boolean): Promise<PieceOutcome> {
    if (!lastTry) return { retry: why };
    await this.fail(p, `GAVE_UP: ${why}`.slice(0, 300));
    return 'failed';
  }

  /** Words (or a skip) first, then — and only then — the audio goes. */
  private async saveWords(p: LiveAudioSegment, text: string, skipReason: string | null) {
    const saved = await this.prisma.liveAudioSegment.updateMany({
      where: { id: p.id, text: null },
      data: { text, skipReason, transcribedAt: new Date() },
    });
    if (saved.count === 0) return;
    await this.storage.delete(p.key).catch(() => undefined);
    await this.prisma.liveAudioSegment
      .update({ where: { id: p.id }, data: { audioDeletedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Failed for good (this run): the audio is KEPT for a retry until retention sweeps it. */
  private fail(p: LiveAudioSegment, error: string) {
    return this.prisma.liveAudioSegment.updateMany({
      where: { id: p.id, text: null },
      data: { error: error.slice(0, 300) },
    });
  }
}
