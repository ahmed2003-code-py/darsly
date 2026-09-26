import { Logger } from '@nestjs/common';
import { AiJob, AiJobType } from '@prisma/client';
import { AiJobError } from '../../academy-site/ai/ai-job.error';
import { AiJobHandler, AiJobResult } from '../../academy-site/jobs/ai-job.handler';
import { MAX_ATTEMPTS } from '../../academy-site/jobs/ai-job.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import {
  LAST_PIECE_GRACE_MS,
  openAiSpeechToText,
  STT_USD_PER_MIN,
  transcriptionConfig,
  type SpeechToText,
} from './lesson-transcription';

/**
 * The LIVE_TRANSCRIBE job: a finished Darsly-hosted class's audio pieces, in
 * order, into one transcript on the class (transcriptText, READY). The pieces
 * are deleted once the words are saved — the transcript is kept, the voices
 * are not.
 *
 * Each piece is transcribed on its own (about three minutes each): well
 * inside the provider's file limit, and a failure retries one piece's worth
 * of work, not the lesson's. A piece's words are saved on its row as soon as
 * they arrive, so a retry never pays for the same audio twice.
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
      select: { id: true, endedAt: true, transcriptStatus: true },
    });
    if (!session) throw new AiJobError('Session no longer exists', 'TERMINAL');
    if (session.transcriptStatus === 'READY') return;
    // The teacher's page flushes its last piece as the class ends; let it land.
    // (Waited here, not retried: the queue retries at once and only 3 times.)
    const since = session.endedAt ? Date.now() - session.endedAt.getTime() : 0;
    if (since < LAST_PIECE_GRACE_MS) await this.sleep(LAST_PIECE_GRACE_MS - since);

    const pieces = await this.prisma.liveAudioSegment.findMany({
      where: { sessionId: liveSessionId, roomName },
      orderBy: { seq: 'asc' },
    });
    if (!pieces.length) {
      // Nothing was captured (the teacher's browser could not, or nobody
      // spoke long enough for a piece): no transcript, and nothing paid for.
      await this.prisma.liveSession.updateMany({
        where: { id: liveSessionId, transcriptStatus: 'PROCESSING' },
        data: { transcriptStatus: 'NOT_STARTED' },
      });
      this.logger.log(`live.transcribe liveSession=${liveSessionId} pieces=0 — nothing captured`);
      return;
    }
    let bytes = 0;
    let paidBytes = 0;
    const texts: string[] = [];
    for (const p of pieces) {
      bytes += p.sizeBytes;
      let text = p.text;
      if (text === null) {
        const audio = await this.storage.getBuffer(p.key);
        try {
          text = await this.stt(audio, `${p.seq}.${p.key.split('.').pop() ?? 'webm'}`);
        } catch (e) {
          // Refused for good, or the queue's last try: the lesson shows it
          // failed, rather than "transcribing" forever.
          const terminal = e instanceof AiJobError && e.errorClass === 'TERMINAL';
          if (terminal || job.attempts >= MAX_ATTEMPTS) await this.markFailed(liveSessionId);
          throw e;
        }
        paidBytes += p.sizeBytes;
        await this.prisma.liveAudioSegment.update({ where: { id: p.id }, data: { text } });
      }
      if (text) texts.push(text);
    }
    const transcript = texts.join('\n').trim();
    await this.prisma.liveSession.update({
      where: { id: liveSessionId },
      data: { transcriptText: transcript || null, transcriptStatus: transcript ? 'READY' : 'FAILED' },
    });
    // The words are kept; the voices are not.
    for (const p of pieces) await this.storage.delete(p.key).catch(() => undefined);
    await this.prisma.liveAudioSegment.deleteMany({ where: { sessionId: liveSessionId, roomName } });

    const cfg = transcriptionConfig();
    // ~32 kbps Opus: bytes → minutes. An estimate, for the log and the budget.
    const minutes = (b: number) => (b * 8) / 32_000 / 60;
    const usd = minutes(paidBytes) * (STT_USD_PER_MIN[cfg.model] ?? 0.006);
    this.logger.log(
      `live.transcribe liveSession=${liveSessionId} pieces=${pieces.length} chars=${transcript.length} ` +
        `estMinutes=${minutes(bytes).toFixed(1)} estUsd=${usd.toFixed(4)} model=${cfg.model}`,
    );
    if (!transcript) throw new AiJobError('The audio held no speech', 'TERMINAL');
    return { costCents: Math.ceil(usd * 100) };
  }

  private async markFailed(sessionId: string) {
    await this.prisma.liveSession.update({ where: { id: sessionId }, data: { transcriptStatus: 'FAILED' } });
  }
}
