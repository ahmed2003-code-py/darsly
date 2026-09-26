import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LiveRecording } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { LiveRtcService } from '../rtc/live-rtc.service';
import { recordingStage } from './recording-stage';
export { recordingStage } from './recording-stage';
export type { RecordingFailure, RecordingStage } from './recording-stage';

/** A recording in these states is being made, or is about to be. */
export const ACTIVE_RECORDING = ['REQUESTED', 'RECORDING', 'STOPPING'] as const;

/**
 * How long a request may wait for a recorder before it is closed as never
 * started — "processing" with nobody recording is the one state that must not
 * last. Generous next to the recorder's 3s tick.
 */
export const UNCLAIMED_AFTER_MS = 2 * 60_000;
/** A recorder silent this long after its class ended is not coming back. */
export const RECORDER_LOST_AFTER_MS = 5 * 60_000;
/** Packaging still not done this long after hand-over has stalled for good. */
export const PROCESSING_STALL_MS = 6 * 3600_000;

/**
 * The teacher's "record" button, for a class Darsly hosts (Cloudflare).
 *
 * Daily recorded in its own cloud and handed back a link; Cloudflare carries
 * media only, so Darsly records it — the recorder worker (LiveRecorderWorker)
 * joins the class as a receive-only participant. This service is the
 * request side: it writes what the teacher asked for; the worker does it.
 *
 * Kept apart from the class itself on purpose: a recording has its own row
 * and its own states (LiveRecording), and nothing here can end, pause or
 * otherwise touch the class. A recorder that fails is a missing recording,
 * never a missing lesson.
 */
@Injectable()
export class LiveRecordingService {
  private readonly logger = new Logger(LiveRecordingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly rtc: LiveRtcService,
  ) {}

  /**
   * Start recording. Idempotent: pressing twice, or two tabs, is one
   * recording — serialised per class so two presses cannot both create one.
   */
  async start(scope: LiveScope, id: string, actorUserId: string) {
    const s = await this.live.ownedSession(scope, id);
    if (s.status !== 'LIVE' || !s.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    const run = s.roomName;
    const r = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-rec:${id}`}))`;
      const active = await tx.liveRecording.findFirst({
        where: {
          sessionId: id,
          roomName: run,
          status: { in: [...ACTIVE_RECORDING] },
          stopRequestedAt: null,
        },
      });
      if (active) return { rec: active, created: false };
      const rec = await tx.liveRecording.create({
        data: { sessionId: id, roomName: run, tenantId: s.tenantId, requestedBy: actorUserId },
      });
      await tx.liveSession.update({
        where: { id },
        data: { recordingStatus: 'PROCESSING', recordingStartedAt: new Date() },
      });
      return { rec, created: true };
    });
    if (r.created) {
      this.logger.log(
        `live.recording.requested liveSession=${id} recording=${r.rec.id} actor=${actorUserId}`,
      );
      this.rtc.changed(id);
    }
    return this.view(r.rec);
  }

  /** Stop. The recorder notices within seconds, closes the file, uploads it. */
  async stop(scope: LiveScope, id: string) {
    await this.live.ownedSession(scope, id);
    const now = new Date();
    const active = await this.prisma.liveRecording.findMany({
      where: { sessionId: id, status: { in: [...ACTIVE_RECORDING] }, stopRequestedAt: null },
    });
    for (const rec of active) {
      if (rec.status === 'REQUESTED') {
        // Never started: nothing was recorded, so there is nothing to keep.
        await this.prisma.liveRecording.updateMany({
          where: { id: rec.id, status: 'REQUESTED' },
          data: { stopRequestedAt: now, status: 'FAILED', error: 'STOPPED_BEFORE_START', failedAt: now },
        });
      } else {
        await this.prisma.liveRecording.updateMany({
          where: { id: rec.id, stopRequestedAt: null },
          data: { stopRequestedAt: now },
        });
      }
    }
    if (active.length) {
      this.logger.log(`live.recording.stop_requested liveSession=${id} recordings=${active.length}`);
      this.rtc.changed(id);
    }
    return { id, stopping: active.length };
  }

  /** Whether this run of the class is being recorded — for the REC badge. */
  async isRecording(sessionId: string, roomName: string): Promise<boolean> {
    const n = await this.prisma.liveRecording.count({
      where: {
        sessionId,
        roomName,
        status: { in: [...ACTIVE_RECORDING] },
        stopRequestedAt: null,
      },
    });
    return n > 0;
  }

  /**
   * Recordings handed to the video pipeline, caught up with it: READY once
   * the encrypted HLS exists, FAILED if packaging gave up. The class's own
   * recordingStatus follows its latest recording.
   */
  async syncProcessing(limit = 25): Promise<number> {
    const rows = await this.prisma.liveRecording.findMany({
      where: { status: 'PROCESSING', videoAssetId: { not: null } },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });
    let changed = 0;
    for (const r of rows) {
      const asset = await this.prisma.videoAsset.findUnique({
        where: { id: r.videoAssetId! },
        select: { status: true, durationSec: true },
      });
      // Still packaging after this long is not coming back (the video worker
      // is off everywhere, say): it fails rather than processing forever.
      const stalled =
        !!r.handedAt && Date.now() - r.handedAt.getTime() > PROCESSING_STALL_MS;
      const next = !asset
        ? 'FAILED'
        : asset.status === 'READY'
          ? 'READY'
          : asset.status === 'FAILED' || stalled
            ? 'FAILED'
            : null;
      if (!next) continue;
      await this.prisma.$transaction([
        this.prisma.liveRecording.update({
          where: { id: r.id },
          data: {
            status: next,
            ...(next === 'READY' ? { readyAt: new Date() } : {}),
            ...(next === 'FAILED'
              ? {
                  failedAt: new Date(),
                  error: !asset
                    ? 'ASSET_MISSING'
                    : asset.status === 'FAILED'
                      ? 'PACKAGING_FAILED'
                      : 'PROCESSING_STALLED',
                }
              : {}),
            ...(asset?.durationSec ? { durationSec: asset.durationSec } : {}),
          },
        }),
        this.prisma.liveSession.update({
          where: { id: r.sessionId },
          data: {
            recordingStatus: next,
            ...(next === 'READY' && asset?.durationSec
              ? { recordingDuration: asset.durationSec }
              : {}),
          },
        }),
      ]);
      this.logger.log(
        `live.recording.${next.toLowerCase()} liveSession=${r.sessionId} recording=${r.id}` +
          (r.handedAt ? ` processingMs=${Date.now() - r.handedAt.getTime()}` : '') +
          ` sinceRequestMs=${Date.now() - r.createdAt.getTime()}`,
      );
      changed++;
    }
    return changed;
  }

  view(r: LiveRecording) {
    return {
      id: r.id,
      sessionId: r.sessionId,
      status: r.status,
      ...recordingStage(r),
      startedAt: r.startedAt,
      stopRequestedAt: r.stopRequestedAt,
      durationSec: r.durationSec,
    };
  }

  /** The latest recording of a class, as the session page shows it. */
  async latestView(sessionId: string) {
    const r = await this.prisma.liveRecording.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });
    return r ? this.view(r) : null;
  }

  /**
   * Nothing may stay "processing" with nobody working on it. Run by the end
   * sweep on every API instance:
   *  - a request no recorder has taken within UNCLAIMED_AFTER_MS, or whose
   *    class has ended before any recorder took it, closes as never started
   *    (nothing was recorded, so there is nothing to wait for);
   *  - a recording whose recorder went silent after its class ended goes to
   *    finalize with whatever pieces reached storage (none → NO_MEDIA).
   */
  async sweepStale(now = Date.now()): Promise<{ notStarted: number; recovered: number }> {
    const unclaimed = await this.prisma.liveRecording.findMany({
      where: {
        status: 'REQUESTED',
        OR: [
          { createdAt: { lt: new Date(now - UNCLAIMED_AFTER_MS) } },
          { session: { OR: [{ status: { not: 'LIVE' } }, { deletedAt: { not: null } }] } },
        ],
      },
      select: { id: true, sessionId: true, createdAt: true },
      take: 50,
    });
    let notStarted = 0;
    for (const r of unclaimed) {
      const done = await this.prisma.liveRecording.updateMany({
        where: { id: r.id, status: 'REQUESTED' },
        data: {
          status: 'FAILED',
          error: r.createdAt.getTime() < now - UNCLAIMED_AFTER_MS ? 'NOT_CLAIMED' : 'NEVER_STARTED',
          stopRequestedAt: new Date(now),
          failedAt: new Date(now),
        },
      });
      if (done.count) {
        notStarted++;
        await this.mirror(r.id);
        this.rtc.changed(r.sessionId);
        this.logger.warn(
          `live.recording.failed recording=${r.id} liveSession=${r.sessionId} reason=NOT_STARTED waitedMs=${now - r.createdAt.getTime()}`,
        );
      }
    }
    const lost = await this.prisma.liveRecording.findMany({
      where: {
        status: { in: ['RECORDING', 'STOPPING'] },
        leaseUntil: { lt: new Date(now - RECORDER_LOST_AFTER_MS) },
        session: { OR: [{ status: { not: 'LIVE' } }, { deletedAt: { not: null } }] },
      },
      select: { id: true, sessionId: true },
      take: 50,
    });
    let recovered = 0;
    for (const r of lost) {
      const done = await this.prisma.liveRecording.updateMany({
        where: { id: r.id, status: { in: ['RECORDING', 'STOPPING'] } },
        data: {
          status: 'UPLOADING',
          stoppedAt: new Date(now),
          leaseOwner: null,
          leaseUntil: null,
          error: 'RECORDER_LOST',
        },
      });
      if (done.count) {
        recovered++;
        this.logger.warn(
          `live.recording.recorder_lost recording=${r.id} liveSession=${r.sessionId} → finalize`,
        );
      }
    }
    return { notStarted, recovered };
  }

  /** The class's recordingStatus follows its latest recording. */
  async mirror(id: string) {
    const r = await this.prisma.liveRecording.findUnique({ where: { id } });
    if (!r) return;
    const latest = await this.prisma.liveRecording.findFirst({
      where: { sessionId: r.sessionId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest?.id !== id) return;
    await this.prisma.liveSession.update({
      where: { id: r.sessionId },
      data: {
        recordingStatus:
          r.status === 'READY' ? 'READY' : r.status === 'FAILED' ? 'FAILED' : 'PROCESSING',
      },
    });
  }
}
