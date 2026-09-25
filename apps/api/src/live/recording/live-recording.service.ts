import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LiveRecording } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { LiveRtcService } from '../rtc/live-rtc.service';

/** A recording in these states is being made, or is about to be. */
export const ACTIVE_RECORDING = ['REQUESTED', 'RECORDING', 'STOPPING'] as const;

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
        `live.rec.requested liveSession=${id} recording=${r.rec.id} actor=${actorUserId}`,
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
          data: { stopRequestedAt: now, status: 'FAILED', error: 'STOPPED_BEFORE_START' },
        });
      } else {
        await this.prisma.liveRecording.updateMany({
          where: { id: rec.id, stopRequestedAt: null },
          data: { stopRequestedAt: now },
        });
      }
    }
    if (active.length) {
      this.logger.log(`live.rec.stop-requested liveSession=${id} recordings=${active.length}`);
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
      const next = !asset
        ? 'FAILED'
        : asset.status === 'READY'
          ? 'READY'
          : asset.status === 'FAILED'
            ? 'FAILED'
            : null;
      if (!next) continue;
      await this.prisma.$transaction([
        this.prisma.liveRecording.update({
          where: { id: r.id },
          data: {
            status: next,
            ...(next === 'FAILED' ? { error: asset ? 'PACKAGING_FAILED' : 'ASSET_MISSING' } : {}),
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
        `live.rec.${next.toLowerCase()} liveSession=${r.sessionId} recording=${r.id}`,
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
      startedAt: r.startedAt,
      stopRequestedAt: r.stopRequestedAt,
      durationSec: r.durationSec,
    };
  }
}
