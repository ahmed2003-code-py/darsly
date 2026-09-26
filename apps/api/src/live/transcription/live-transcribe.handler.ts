import { Logger } from '@nestjs/common';
import { AiJob, AiJobType, LiveAudioSegment } from '@prisma/client';
import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { AiJobHandler, AiJobResult } from '../../academy-site/jobs/ai-job.handler';
import { MAX_ATTEMPTS } from '../../academy-site/jobs/ai-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import {
  assembleTranscript,
  LAST_PIECE_GRACE_MS,
  openAiSpeechToText,
  sttUsdPerMin,
  transcriptionConfig,
  type SpeechToText,
} from './lesson-transcription';

/** ~32 kbps Opus — the fallback when a piece did not say how long it was. */
const estimateMs = (p: { durationMs: number | null; sizeBytes: number }) =>
  p.durationMs ?? Math.round(((p.sizeBytes * 8) / 32_000) * 1000);

/**
 * The LIVE_TRANSCRIBE job: a finished Darsly-hosted class's audio pieces, in
 * order, into one transcript on the class (transcriptText + timestamped
 * transcriptSegments). The pieces are deleted once the words are saved — the
 * transcript is kept, the voices are not.
 *
 * Each piece is transcribed on its own (about three minutes each): well
 * inside the provider's file limit, and a failure retries one piece's worth
 * of work, not the lesson's. A piece's words are saved on its row as soon as
 * they arrive, so a retry never pays for the same audio twice.
 *
 * One piece the provider refuses for good (TERMINAL) is marked and skipped:
 * the rest of the lesson is still transcribed, and the transcript says it is
 * partial. An outage (RETRYABLE) is retried by the queue; on its last attempt
 * the pieces still owed are given up on the same way, so a transcript never
 * sits in "processing" once the queue has stopped trying.
 *
 * Every call is recorded in AiCallLog against the lesson and the job (the
 * cost is an estimate from the audio's length at the list price), and the
 * job's cost counts toward the monthly AI budget.
 *
 * Built by a factory in AcademySiteModule (no decorators): the speech-to-text
 * call and the wait are plain arguments, so a test passes fakes for both.
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
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.stt = stt ?? openAiSpeechToText();
  }

  async handle(job: AiJob): Promise<AiJobResult | void> {
    const { liveSessionId, roomName } = (job.input ?? {}) as { liveSessionId?: string; roomName?: string };
    if (!liveSessionId || !roomName) throw new AiJobError('No session on job', 'TERMINAL');
    const session = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: { id: true, title: true, startedAt: true, endedAt: true, transcriptStatus: true },
    });
    if (!session) throw new AiJobError('Session no longer exists', 'TERMINAL');
    if (session.transcriptStatus === 'READY') return;
    // The teacher's page flushes its last piece as the class ends; let it land.
    // (Waited here, not retried: the queue retries at once and only 3 times.)
    const since = session.endedAt ? Date.now() - session.endedAt.getTime() : 0;
    if (since < LAST_PIECE_GRACE_MS) await this.sleep(LAST_PIECE_GRACE_MS - since);

    const startedAt = new Date();
    const pieces = await this.prisma.liveAudioSegment.findMany({
      where: { sessionId: liveSessionId, roomName },
      orderBy: { seq: 'asc' },
    });
    if (!pieces.length) {
      // Nothing was captured (capture never ran, or nobody spoke long enough
      // for a piece): no transcript, and nothing paid for.
      await this.prisma.liveSession.updateMany({
        where: { id: liveSessionId, transcriptStatus: 'PROCESSING' },
        data: { transcriptStatus: 'NOT_STARTED' },
      });
      this.logger.log(`live.transcript.nothing-captured liveSession=${liveSessionId} job=${job.id}`);
      return;
    }
    const cfg = transcriptionConfig();
    const lastTry = job.attempts >= MAX_ATTEMPTS;
    let paidMs = 0;
    for (const p of pieces) {
      if (p.text !== null || p.error) continue;
      try {
        await this.transcribePiece(job, p, session.title, cfg.model);
        paidMs += estimateMs(p);
      } catch (e) {
        if (e instanceof AiJobError && e.errorClass === 'TERMINAL') {
          // This piece alone: refused for good, so the rest go on.
          await this.prisma.liveAudioSegment.update({
            where: { id: p.id },
            data: { error: e.message.slice(0, 300) },
          });
          continue;
        }
        if (!lastTry) throw e;
        // The queue will not try again: what is still owed is given up on,
        // and the lesson gets whatever words were saved.
        await this.prisma.liveAudioSegment.updateMany({
          where: { sessionId: liveSessionId, roomName, text: null, error: null },
          data: { error: `GAVE_UP: ${(e as Error).message.slice(0, 200)}` },
        });
        break;
      }
    }

    const done = await this.prisma.liveAudioSegment.findMany({
      where: { sessionId: liveSessionId, roomName },
      orderBy: { seq: 'asc' },
    });
    const classStartSec = Math.floor(
      (session.startedAt?.getTime() ?? done[0].seq * 1000) / 1000,
    );
    const { segments, text } = assembleTranscript(done, classStartSec);
    const failed = done.filter((p) => p.error).length;
    const audioMs = done.reduce((n, p) => n + estimateMs(p), 0);
    const meta = {
      pieces: done.length,
      transcribed: done.filter((p) => p.text !== null).length,
      silent: done.filter((p) => p.text === '').length,
      failed,
      partial: failed > 0 && !!text,
      audioSeconds: Math.round(audioMs / 1000),
      model: cfg.model,
      estUsd: Number(((audioMs / 60_000) * sttUsdPerMin(cfg.model)).toFixed(4)),
      jobId: job.id,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
    await this.prisma.liveSession.update({
      where: { id: liveSessionId },
      data: {
        transcriptText: text || null,
        transcriptSegments: text ? (segments as object[]) : undefined,
        transcriptStatus: text ? 'READY' : 'FAILED',
        transcriptMeta: meta,
      },
    });
    // The words are kept; the voices are not — whether or not they became
    // words. (Audio of a lesson whose transcript failed is not kept "for
    // later": the retention sweep handles only what never reached this job.)
    for (const p of done) await this.storage.delete(p.key).catch(() => undefined);
    await this.prisma.liveAudioSegment.deleteMany({ where: { sessionId: liveSessionId, roomName } });

    const usd = (paidMs / 60_000) * sttUsdPerMin(cfg.model);
    this.logger.log(
      `live.transcript.${text ? 'assembled' : 'failed'} liveSession=${liveSessionId} job=${job.id} ` +
        `pieces=${meta.pieces} failed=${failed} silent=${meta.silent} audioSec=${meta.audioSeconds} ` +
        `paidSec=${Math.round(paidMs / 1000)} estUsd=${usd.toFixed(4)} model=${cfg.model} ` +
        `ms=${Date.now() - startedAt.getTime()}`,
    );
    if (!text) throw new AiJobError('The audio held no speech', 'TERMINAL');
    return { costCents: Math.ceil(usd * 100) };
  }

  /** One piece → its words, saved on its row; the call recorded either way. */
  private async transcribePiece(job: AiJob, p: LiveAudioSegment, title: string, model: string) {
    const audio = await this.storage.getBuffer(p.key);
    const t0 = Date.now();
    const ms = estimateMs(p);
    let status = 'ok';
    let error: string | null = null;
    try {
      const text = await this.stt(audio, `${p.seq}.${p.key.split('.').pop() ?? 'webm'}`, {
        prompt: title,
      });
      await this.prisma.liveAudioSegment.update({
        where: { id: p.id },
        data: { text, transcribedAt: new Date() },
      });
      p.text = text;
      this.logger.log(
        `live.transcript.segment-ready liveSession=${p.sessionId} seq=${p.seq} audioSec=${Math.round(ms / 1000)} ms=${Date.now() - t0}`,
      );
    } catch (e) {
      status = 'failed';
      error = (e as Error).message.slice(0, 300);
      throw e;
    } finally {
      // A refused call may still be billed; an unreachable one is not, but the
      // record of the attempt is what explains a gap later.
      await this.prisma.aiCallLog
        .create({
          data: {
            stage: 'LIVE_TRANSCRIBE',
            model,
            startedAt: new Date(t0),
            latencyMs: Date.now() - t0,
            status,
            error,
            costMillicents:
              status === 'ok' ? Math.round((ms / 60_000) * sttUsdPerMin(model) * 100_000) : 0,
            liveSessionId: p.sessionId,
            aiJobId: job.id,
            meta: { seq: p.seq, audioSec: Math.round(ms / 1000), bytes: p.sizeBytes },
          },
        })
        .catch((e) => this.logger.warn(`AiCallLog write failed: ${(e as Error).message}`));
    }
  }
}
