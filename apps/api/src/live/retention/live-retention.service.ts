import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import { audioPrefix, transcriptionConfig } from '../transcription/lesson-transcription';

/** A failed recording's raw pieces are kept this long (to investigate, or re-run), then deleted. */
export function failedRecordingRetentionHours(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.LIVE_RECORDING_FAILED_RETENTION_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 72;
}
/** How far back the "delete whatever is left" pass looks (it is idempotent, so bounded). */
const LOOKBACK_MS = 7 * 24 * 3600_000;
const BATCH = 50;

/**
 * Temporary media is temporary.
 *
 * The lesson's *recording* is a VideoAsset and is kept like any video — it is
 * never touched here. What is swept is the scaffolding around it:
 *
 *  - Transcription audio (source/live-audio/…). A successful transcript
 *    deletes its own audio at once (LiveTranscribeHandler). What reaches this
 *    sweep is audio that never became a transcript — the AI queue refused the
 *    job, the class was cancelled, the teacher's page uploaded a piece after
 *    the job ran — and it is deleted LIVE_AUDIO_RETENTION_HOURS (default 24)
 *    after it was uploaded, unless its transcript is being made right now.
 *    Objects whose row never landed (a crash between the upload and the
 *    insert) go with their class's folder once the class is that old.
 *  - A FAILED recording's raw pieces (source/live-rec/<id>/), kept
 *    LIVE_RECORDING_FAILED_RETENTION_HOURS (default 72) after it failed.
 *
 * Idempotent and bounded: every pass deletes at most a batch of each, and
 * deleting what is already gone is a no-op.
 */
@Injectable()
export class LiveRetentionService {
  private readonly logger = new Logger(LiveRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  async sweep(now = Date.now()): Promise<{ audioPieces: number; audioFolders: number; recordings: number }> {
    const audioCut = new Date(now - transcriptionConfig().audioRetentionHours * 3600_000);

    // 1. Pieces that outlived their purpose.
    const stale = await this.prisma.liveAudioSegment.findMany({
      where: { createdAt: { lt: audioCut }, session: { transcriptStatus: { not: 'PROCESSING' } } },
      select: { id: true, key: true, sessionId: true },
      take: BATCH,
    });
    for (const p of stale) {
      await this.storage.delete(p.key).catch(() => undefined);
      await this.prisma.liveAudioSegment.delete({ where: { id: p.id } }).catch(() => undefined);
    }

    // 2. What is left in the folders of classes that old (orphaned objects).
    const oldClasses = await this.prisma.liveSession.findMany({
      where: {
        provider: 'CLOUDFLARE',
        transcriptionMode: { not: 'OFF' },
        transcriptStatus: { not: 'PROCESSING' },
        OR: [
          { endedAt: { lt: audioCut, gte: new Date(audioCut.getTime() - LOOKBACK_MS) } },
          { deletedAt: { lt: audioCut, gte: new Date(audioCut.getTime() - LOOKBACK_MS) } },
        ],
        audioSegments: { none: {} },
      },
      select: { id: true },
      take: BATCH,
    });
    for (const s of oldClasses) {
      await this.storage.deletePrefix(audioPrefix(s.id)).catch(() => undefined);
    }

    // 3. Failed recordings' raw pieces.
    const recCut = new Date(now - failedRecordingRetentionHours() * 3600_000);
    const failed = await this.prisma.liveRecording.findMany({
      where: { status: 'FAILED', failedAt: { lt: recCut, gte: new Date(recCut.getTime() - LOOKBACK_MS) } },
      select: { id: true },
      take: BATCH,
    });
    for (const r of failed) {
      await this.storage.deletePrefix(`source/live-rec/${r.id}/`).catch(() => undefined);
    }

    if (stale.length || failed.length) {
      this.logger.log(
        `live.retention audioPieces=${stale.length} audioFolders=${oldClasses.length} failedRecordings=${failed.length}`,
      );
    }
    return { audioPieces: stale.length, audioFolders: oldClasses.length, recordings: failed.length };
  }
}
