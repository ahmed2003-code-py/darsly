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
  SttError,
  sttFailureKind,
  sttUsdPerMin,
  transcriptionConfig,
  TRANSIENT_STT_FAILURES,
  type SpeechToText,
  type SttFailureKind,
} from './lesson-transcription';
import {
  estimateMs,
  isPromptEcho,
  isTooShort,
  looksLikeRepetitionLoop,
  MAX_IN_RUN_WAIT_MS,
  PIECE_QUICK_RETRY_MS,
  retryDelayFor,
} from './stt-guards';
import { finalizeTranscript, type TranscriptChanged } from './transcript-assembly';

/** How long one owner holds a class before another job may take over. Renewed before every call. */
export const TRANSCRIPT_LEASE_MS = 4 * 60_000;
/** After the upload window closes, a moment for the last upload's row to land. */
const UPLOAD_SETTLE_MS = 5_000;
/** An echo of the title on a piece this short is silence; on a longer one it is lost speech. */
const ECHO_IS_SILENCE_BELOW_MS = 10_000;
/** New pieces appearing while the job works are picked up, a bounded number of times. */
const MAX_ROUNDS = 6;
/** Pieces transcribed at once: a long class takes a fraction of the time, the provider is never flooded. */
export const TRANSCRIBE_CONCURRENCY = 3;

/**
 * One piece's result (`billed`: provider answers received, each one paid):
 *  done / skipped  its words (or a skip) are saved;
 *  failed          failed for good in this run (bad file, audio gone, rejected twice);
 *  owed            an outage, timeout or rate limit outlasted the quick retries: tried again later;
 *  account         the provider refuses the account: nothing else is worth sending.
 */
type PieceOutcome =
  | { kind: 'done' | 'skipped' | 'failed'; billed: number }
  | { kind: 'owed'; billed: number; why: string; waitMs?: number; rateLimited: boolean }
  | { kind: 'account'; billed: number; why: string };

type CallResult = { ok: true; text: string } | { ok: false; kind: SttFailureKind; why: string; waitMs?: number };

/**
 * The LIVE_TRANSCRIBE job: a finished Darsly-hosted class's audio pieces, in
 * the order spoken, into one transcript on the class.
 *
 *  - One owner per class. The job claims a lease on the session and renews it
 *    before every provider call; a second job (duplicate delivery, a lease
 *    reclaimed from a stalled worker) finds it held and steps aside, and a
 *    stalled owner that lost it stops before paying for another piece.
 *  - Work starts at once on the pieces already uploaded, up to
 *    TRANSCRIBE_CONCURRENCY at a time, while the upload window for the last
 *    piece is still open. Once it has closed, anything that arrived is done
 *    too, and only then is the transcript decided. Order never depends on
 *    timing: the transcript is assembled by when each piece was said.
 *  - Each piece's words are saved on its row the moment they arrive, and only
 *    then is that piece's audio deleted. A piece that failed keeps its audio
 *    (for a retry, until the retention window ends).
 *  - Failures are handled by what they are (SttFailureKind):
 *      · the provider refusing the account (no credits, billing, bad key)
 *        stops the run at once. Every piece still owed is marked
 *        PROVIDER_UNAVAILABLE with its audio kept, and the class is decided
 *        now, not after 20 minutes of retries that cannot succeed;
 *      · an outage, timeout or rate limit is retried inside the run (≈2 s,
 *        8 s) while the other pieces carry on. Whatever is still owed after
 *        that asks the queue to try again (≈30 s, 2, 8 min); after the last
 *        attempt it fails and the transcript is PARTIAL;
 *      · a file the provider cannot read fails that piece alone;
 *      · an answer the guards reject (the title echoed back for a long piece,
 *        a repetition loop) is asked for once more at once (without the
 *        title, for an echo). If it comes back the same, that piece fails;
 *        a model that answered the same audio the same way twice will not do
 *        better in 15 minutes.
 *  - A piece under 2 s is never sent; the title echoed back for a short piece
 *    is silence (see stt-guards.ts).
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
    const t0 = Date.now();
    const ctx = `liveSession=${liveSessionId} job=${job.id} attempt=${job.attempts}`;
    const sinceEnd = () => (session.endedAt ? Date.now() - session.endedAt.getTime() : -1);

    if (!(await this.claim(job.id, liveSessionId))) {
      this.logger.log(`live.transcript.not-owner ${ctx}`);
      return;
    }
    const cfg = transcriptionConfig();
    const lastTry = job.attempts >= maxAttemptsFor(job.type);
    const queuedSince = Math.max(job.createdAt?.getTime?.() ?? t0, job.runAfter?.getTime?.() ?? 0);
    this.logger.log(
      `live.transcript.start ${ctx} queueWaitMs=${Math.max(0, t0 - queuedSince)} sinceEndMs=${sinceEnd()} model=${cfg.model}`,
    );
    // Pieces are accepted until LAST_PIECE_GRACE_MS after the end. The ones
    // already here are worked on meanwhile; the transcript is decided only
    // once that window has closed, so nothing can arrive behind it.
    const windowClosesAt = session.endedAt ? session.endedAt.getTime() + LAST_PIECE_GRACE_MS + UPLOAD_SETTLE_MS : 0;
    let billedMs = 0;
    let account: string | null = null;
    let rateLimited = false;
    const owed = new Map<string, Extract<PieceOutcome, { kind: 'owed' }>>();
    try {
      for (let round = 0; round < MAX_ROUNDS && !account && !rateLimited; round++) {
        const todo = (
          await this.prisma.liveAudioSegment.findMany({
            where: { sessionId: liveSessionId, roomName, text: null, error: null },
            orderBy: { seq: 'asc' },
          })
        ).filter((p) => !owed.has(p.id));
        if (!todo.length) {
          const wait = windowClosesAt - Date.now();
          if (wait <= 0) break;
          await this.sleep(wait);
          if (!(await this.claim(job.id, liveSessionId))) return;
          continue;
        }
        const lost = await this.pool(
          todo,
          async (p) => {
            const out = await this.piece(job, p, session.title, cfg.model, lastTry);
            billedMs += out.billed * estimateMs(p);
            if (out.kind === 'account') account = out.why;
            if (out.kind === 'owed') {
              owed.set(p.id, out);
              // Asked to slow down: start nothing else in this run.
              if (out.rateLimited) rateLimited = true;
            }
            return account || rateLimited ? 'stop' : 'go';
          },
          () => this.claim(job.id, liveSessionId),
        );
        // Lost the class to another job: stop, and the new owner decides it.
        if (lost) return;
      }

      if (account) {
        // Nothing will be answered until the account is fixed: every piece
        // still owed fails now, its audio kept for the teacher's retry.
        await this.prisma.liveAudioSegment.updateMany({
          where: { sessionId: liveSessionId, roomName, text: null, error: null },
          data: { error: `PROVIDER_UNAVAILABLE: ${account}`.slice(0, 300) },
        });
        this.logger.error(
          `live.transcript.provider-unavailable ${ctx} class=ACCOUNT detail="${account}": ` +
            'the transcription provider refuses this account (credits, billing or key); the audio is kept',
        );
      } else if ((owed.size || rateLimited) && !lastTry) {
        // Everything saved so far stays saved; the rest is tried again later.
        const waits = [...owed.values()].map((o) => o.waitMs ?? 0);
        const delay = Math.max(retryDelayFor(job.attempts), Math.min(Math.max(0, ...waits), 10 * 60_000));
        const why = [...owed.values()][0]?.why ?? 'rate limited';
        this.logger.warn(
          `live.transcript.retry-later ${ctx} class=${rateLimited ? 'RATE_LIMIT' : 'TRANSIENT'} owed=${owed.size} ` +
            `inMs=${delay} nextRunAfter=${new Date(Date.now() + delay).toISOString()} why="${why}"`,
        );
        throw new AiJobError(`Transcription will be retried: ${why}`, 'RETRYABLE', undefined, delay);
      }
      const out = await finalizeTranscript(this.prisma, {
        sessionId: liveSessionId,
        roomName,
        jobId: job.id,
        model: cfg.model,
        giveUpPending: lastTry,
        onChanged: this.onChanged,
      });
      const usd = (billedMs / 60_000) * sttUsdPerMin(cfg.model);
      this.logger.log(
        `live.transcript.${out.status.toLowerCase()} ${ctx} pieces=${out.meta.pieces} failed=${out.meta.failed} ` +
          `skipped=${out.meta.skipped} reason=${out.meta.reason ?? '-'} billedSec=${Math.round(billedMs / 1000)} ` +
          `estUsd=${usd.toFixed(4)} model=${cfg.model} runMs=${Date.now() - t0} sinceEndMs=${sinceEnd()}`,
      );
      if (out.status === 'PENDING') {
        throw new AiJobError('New audio arrived while finishing; trying again', 'RETRYABLE', undefined, retryDelayFor(1));
      }
      return { costCents: Math.ceil(usd * 100) };
    } finally {
      await this.release(job.id, liveSessionId);
    }
  }

  /**
   * Runs `work` over the pieces in order, TRANSCRIBE_CONCURRENCY at a time.
   * The lease is renewed before each piece; once it is lost nothing more is
   * started and `true` is returned. `work` returning 'stop' starts nothing more.
   */
  private async pool(
    pieces: LiveAudioSegment[],
    work: (p: LiveAudioSegment) => Promise<'go' | 'stop'>,
    renew: () => Promise<boolean>,
  ): Promise<boolean> {
    let next = 0;
    let stop = false;
    let lost = false;
    const lane = async () => {
      while (!stop && next < pieces.length) {
        const p = pieces[next++];
        if (!(await renew())) {
          lost = stop = true;
          return;
        }
        if ((await work(p)) === 'stop') stop = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, pieces.length) }, lane));
    return lost;
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

  /**
   * One piece → its words (saved, then its audio deleted), a skip, a failure,
   * or "owed". Transient failures are retried here a couple of times; an
   * answer the guards reject is asked for once more.
   */
  private async piece(job: AiJob, p: LiveAudioSegment, title: string, model: string, lastTry: boolean): Promise<PieceOutcome> {
    const ms = estimateMs(p);
    if (isTooShort(p)) {
      await this.saveWords(p, '', 'TOO_SHORT');
      return { kind: 'skipped', billed: 0 };
    }
    let audio: Buffer;
    try {
      audio = await this.storage.getBuffer(p.key);
    } catch (e) {
      // The audio is gone (swept, or never stored): nothing to transcribe, ever.
      await this.fail(p, `AUDIO_MISSING: ${(e as Error).message.slice(0, 150)}`);
      this.logger.warn(`live.transcript.audio-missing liveSession=${p.sessionId} seq=${p.seq}`);
      return { kind: 'failed', billed: 0 };
    }
    const filename = `${p.seq}.${p.key.split('.').pop() ?? 'webm'}`;
    let billed = 0;
    let calls = 0;
    let rerolled = false;
    let quick = 0;
    let prompt: string | undefined = title;
    for (;;) {
      // A stalled owner that lost the class pays for nothing more.
      if (calls++ > 0 && !(await this.claim(job.id, p.sessionId))) return { kind: 'failed', billed };
      const r = await this.call(job, p, audio, filename, prompt, title, model, ms);
      if (r.ok) {
        billed++;
        if (isPromptEcho(r.text, title, ms)) {
          if (ms < ECHO_IS_SILENCE_BELOW_MS) {
            await this.saveWords(p, '', 'PROMPT_ECHO');
            return { kind: 'skipped', billed };
          }
          // A long piece answered with the title: the speech in it was lost.
          // The title is what came back, so ask again without it, once.
          if (!rerolled) {
            rerolled = true;
            prompt = undefined;
            continue;
          }
          await this.fail(p, 'GUARD_REJECTED: PROMPT_ECHO (the answer was the lesson title, twice)');
          return { kind: 'failed', billed };
        }
        if (looksLikeRepetitionLoop(r.text, ms)) {
          if (!rerolled) {
            rerolled = true;
            continue;
          }
          await this.fail(p, 'GUARD_REJECTED: REPETITION_LOOP (the answer repeated itself, twice)');
          return { kind: 'failed', billed };
        }
        await this.saveWords(p, r.text, null);
        return { kind: 'done', billed };
      }
      if (r.kind === 'ACCOUNT') return { kind: 'account', billed, why: r.why };
      if (!TRANSIENT_STT_FAILURES.includes(r.kind)) {
        // Refused for good (a file it cannot read): this piece alone; the rest go on.
        await this.fail(p, `${r.kind === 'BAD_AUDIO' ? 'BAD_AUDIO' : 'REFUSED'}: ${r.why}`);
        return { kind: 'failed', billed };
      }
      const rateLimited = r.kind === 'RATE_LIMIT';
      // Quick retries inside the run; a rate limit gets one, after the wait it asked for.
      if (quick < PIECE_QUICK_RETRY_MS.length && !(rateLimited && quick > 0)) {
        const wait = rateLimited
          ? Math.min(r.waitMs ?? PIECE_QUICK_RETRY_MS[quick], MAX_IN_RUN_WAIT_MS)
          : PIECE_QUICK_RETRY_MS[quick];
        quick++;
        await this.sleep(wait);
        continue;
      }
      if (lastTry) {
        await this.fail(p, `GAVE_UP: ${r.kind} ${r.why}`);
        return { kind: 'failed', billed };
      }
      return { kind: 'owed', billed, why: `${r.kind} ${r.why}`, waitMs: r.waitMs, rateLimited };
    }
  }

  /** One provider call, timed and logged (AiCallLog + a log line): never the audio or the words. */
  private async call(
    job: AiJob,
    p: LiveAudioSegment,
    audio: Buffer,
    filename: string,
    prompt: string | undefined,
    title: string,
    model: string,
    ms: number,
  ): Promise<CallResult> {
    await this.prisma.liveAudioSegment.update({ where: { id: p.id }, data: { attempts: { increment: 1 } } });
    const t0 = Date.now();
    let r: CallResult;
    try {
      r = { ok: true, text: await this.stt(audio, filename, prompt ? { prompt } : {}) };
    } catch (e) {
      r = {
        ok: false,
        kind: sttFailureKind(e),
        why: (e instanceof SttError ? e.detail : (e as Error).message).slice(0, 200),
        waitMs: e instanceof AiJobError ? e.retryAfterMs : undefined,
      };
    }
    const latency = Date.now() - t0;
    const status = !r.ok
      ? 'failed'
      : isPromptEcho(r.text, title, ms)
        ? ms < ECHO_IS_SILENCE_BELOW_MS
          ? 'echo-skipped'
          : 'echo'
        : looksLikeRepetitionLoop(r.text, ms)
          ? 'loop'
          : 'ok';
    this.logger.log(
      `live.transcript.stt liveSession=${p.sessionId} job=${job.id} seq=${p.seq} audioSec=${Math.round(ms / 1000)} ` +
        `jobAttempt=${job.attempts} model=${model} providerMs=${latency} outcome=${status}` +
        (prompt ? '' : ' noPrompt=1') +
        (r.ok ? '' : ` class=${r.kind} why="${r.why}"`),
    );
    // Every provider call is recorded, never the words. A refused call is
    // not billed; an answer we rejected (echo, loop) certainly was.
    await this.prisma.aiCallLog
      .create({
        data: {
          stage: 'LIVE_TRANSCRIBE',
          model,
          startedAt: new Date(t0),
          latencyMs: latency,
          status,
          error: r.ok ? null : `${r.kind}: ${r.why}`.slice(0, 300),
          costMillicents: r.ok ? Math.round((ms / 60_000) * sttUsdPerMin(model) * 100_000) : 0,
          liveSessionId: p.sessionId,
          aiJobId: job.id,
          meta: {
            seq: p.seq,
            audioSec: Math.round(ms / 1000),
            bytes: p.sizeBytes,
            jobAttempt: job.attempts,
            ...(r.ok ? {} : { class: r.kind }),
            ...(prompt ? {} : { noPrompt: true }),
          },
        },
      })
      .catch((err) => this.logger.warn(`AiCallLog write failed: ${(err as Error).message}`));
    return r;
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
