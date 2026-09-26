import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CloudflareRealtimeClient } from './cloudflare-realtime.client';
import { usageOf } from './live-usage';
import {
  LiveProvider,
  LiveRoom,
  MeetingAccess,
  ParticipantAccessInput,
  RoomCloseResult,
} from './live-provider';
import { transcriptionConfig } from '../transcription/lesson-transcription';

/**
 * After this many failed teardown attempts a connection is marked closed
 * anyway: Cloudflare ends an SFU session on its own once its peer is gone, and
 * the class is already closed on Darsly's side, so nothing can rejoin it.
 */
const CLEANUP_MAX_ATTEMPTS = 5;
/** SFU teardown calls in flight at once (Cloudflare allows 50 req/s per session). */
const CLOSE_CONCURRENCY = 5;

/**
 * Cloudflare Realtime SFU as a Darsly classroom — the primary provider.
 *
 * Cloudflare has no rooms: only SFU sessions, one per browser connection, that
 * push and pull tracks. So the classroom is Darsly's — `roomName` is a key for
 * this run of the class, the connections and tracks that make it up are rows
 * (LiveRtcConnection / LiveRtcTrack), and every push and pull goes through
 * Darsly's RTC endpoints (LiveRtcService), which decide who may send and
 * receive what. Opening a class costs no provider call at all.
 *
 * Closing it is Darsly's too: under the row lock the class is simply marked
 * ENDED (`cleanup-pending`) — from that moment nobody can join, push or pull —
 * and the published tracks are then force-closed at the SFU (`cleanup`), which
 * stops the media for anyone still connected. Retried by the end sweep.
 */
@Injectable()
export class CloudflareLiveProvider implements LiveProvider {
  readonly kind = 'CLOUDFLARE' as const;
  private readonly logger = new Logger(CloudflareLiveProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    readonly client: CloudflareRealtimeClient,
  ) {}

  get configured(): boolean {
    return this.client.configured;
  }

  async openRoom(input: { sessionId: string; startsAtMs: number }): Promise<LiveRoom> {
    // A fresh key per run: a class ended and reopened inside its window must
    // not inherit the last run's connections, hands or tracks.
    return { name: `cf-${input.sessionId}-${Date.now().toString(36)}`, url: null };
  }

  async participantAccess(input: ParticipantAccessInput): Promise<MeetingAccess> {
    return {
      provider: 'cloudflare',
      iceServers: await this.client.iceServers(),
      rtcPath: `/live/${input.session.id}/rtc`,
      ...(input.role === 'TEACHER' && transcriptionConfig().enabled ? { transcribe: true } : {}),
    };
  }

  async closeRoom(): Promise<RoomCloseResult> {
    // Nothing to call and nothing to write under the lock: the class turning
    // ENDED is what closes it (every RTC endpoint checks that first).
    return 'cleanup-pending';
  }

  async cleanup(input: { sessionId: string; roomName: string }): Promise<boolean> {
    const open = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId: input.sessionId, roomName: input.roomName, closedAt: null },
      select: { id: true },
    });
    const done = await this.closeConnections(
      open.map((c) => c.id),
      'class-ended',
    );
    this.logger.log(
      `live.cleanup liveSession=${input.sessionId} connections=${open.length} closed=${done.closed} pending=${done.pending}`,
    );
    if (done.pending === 0)
      await this.captureUsage(input).catch((e) => {
        this.logger.warn(
          `live.usage capture failed liveSession=${input.sessionId}: ${(e as Error).message}`,
        );
      });
    return done.pending === 0;
  }

  /**
   * The run's usage, kept on the class once its connections are all closed
   * (see live-usage.ts). Keyed by run, so a class reopened inside its window
   * keeps each run's figures; written once per run.
   */
  async captureUsage(input: { sessionId: string; roomName: string }): Promise<void> {
    const s = await this.prisma.liveSession.findUnique({
      where: { id: input.sessionId },
      select: { usage: true, endedAt: true, status: true },
    });
    if (!s || s.status !== 'ENDED') return;
    const prior = (s.usage ?? {}) as Record<string, unknown>;
    if (prior[input.roomName]) return;
    const [conns, rec] = await Promise.all([
      this.prisma.liveRtcConnection.findMany({
        where: { sessionId: input.sessionId, roomName: input.roomName },
        select: { role: true, purpose: true, createdAt: true, closedAt: true },
      }),
      this.prisma.liveRecording.aggregate({
        where: { sessionId: input.sessionId, roomName: input.roomName },
        _sum: { durationSec: true },
      }),
    ]);
    const usage = usageOf(conns, {
      endedAt: s.endedAt ?? new Date(),
      recordedSec: rec._sum.durationSec ?? 0,
    });
    await this.prisma.liveSession.update({
      where: { id: input.sessionId },
      data: { usage: { ...prior, [input.roomName]: usage } as any },
    });
    this.logger.log(
      `live.usage liveSession=${input.sessionId} connections=${usage.connections} ` +
        `receiveMin=${usage.receiveMinutes.student + usage.receiveMinutes.teacher} peak=${usage.peakReceivers} ` +
        `recordedMin=${usage.recordedMinutes} estEgressGb=${usage.estimate.egressGb}`,
    );
  }

  /**
   * The retry loop for teardown, run by the end sweep: connections whose
   * close was asked for (a revoke, a replaced connection, a removal) and did
   * not finish, and connections of runs that are over — a class that ended,
   * was cancelled, or was reopened as a new run.
   */
  async sweepPending(limit: number): Promise<{ closed: number; pending: number }> {
    const rows = await this.prisma.$queryRaw<{ id: string; over: boolean }[]>(Prisma.sql`
      SELECT c.id,
             (s.status <> 'LIVE' OR s."deletedAt" IS NOT NULL
              OR s."roomName" IS DISTINCT FROM c."roomName") AS over
      FROM "LiveRtcConnection" c JOIN "LiveSession" s ON s.id = c."sessionId"
      WHERE c."closedAt" IS NULL
        AND (c."closeReason" IS NOT NULL
             OR s.status <> 'LIVE' OR s."deletedAt" IS NOT NULL
             OR s."roomName" IS DISTINCT FROM c."roomName")
      ORDER BY c."createdAt"
      LIMIT ${limit}`);
    if (!rows.length) return { closed: 0, pending: 0 };
    return this.closeConnections(
      rows.map((r) => r.id),
      'class-ended',
    );
  }

  /**
   * Close connections: their published tracks are force-closed at the SFU
   * (whoever was watching them stops receiving, whatever the publisher's
   * browser does next), then the rows are marked closed.
   *
   * The request is written first (`closeReason`), so from that moment the
   * connection can no longer push, and its tracks can no longer be pulled —
   * even if the SFU call below fails and is left to the sweep. Receive-only
   * connections need no SFU call: with nothing published they carry nothing
   * anyone else sees, and Cloudflare expires the idle session itself. After
   * CLEANUP_MAX_ATTEMPTS failures a connection is marked closed anyway.
   */
  async closeConnections(
    ids: string[],
    reason: string,
  ): Promise<{ closed: number; pending: number }> {
    if (!ids.length) return { closed: 0, pending: 0 };
    await this.prisma.liveRtcConnection.updateMany({
      where: { id: { in: ids }, closedAt: null, closeReason: null },
      data: { closeReason: reason },
    });
    const conns = await this.prisma.liveRtcConnection.findMany({
      where: { id: { in: ids }, closedAt: null },
      select: {
        id: true,
        cfSessionId: true,
        closeReason: true,
        cleanupAttempts: true,
        tracks: { where: { closedAt: null }, select: { mid: true } },
      },
    });
    // Nothing published: nothing to close at the SFU — all of them in one
    // statement, so a class of fifty listeners is not fifty round trips
    // queued behind one slow teardown.
    const quiet = conns.filter((c) => !c.tracks.length).map((c) => c.id);
    if (quiet.length) {
      await this.prisma.liveRtcConnection.updateMany({
        where: { id: { in: quiet }, closedAt: null },
        data: { closedAt: new Date() },
      });
    }
    let closed = quiet.length;
    let pending = 0;
    // Publishers: the SFU calls in parallel, a few at a time.
    const publishers = conns.filter((c) => c.tracks.length);
    for (let i = 0; i < publishers.length; i += CLOSE_CONCURRENCY) {
      const batch = publishers.slice(i, i + CLOSE_CONCURRENCY);
      const done = await Promise.all(batch.map((c) => this.closeOne(c, reason)));
      for (const d of done) d ? closed++ : pending++;
    }
    return { closed, pending };
  }

  private async closeOne(
    c: {
      id: string;
      cfSessionId: string;
      closeReason: string | null;
      cleanupAttempts: number;
      tracks: { mid: string }[];
    },
    reason: string,
  ): Promise<boolean> {
    let ok = true;
    try {
      await this.client.closeTracks(
        c.cfSessionId,
        c.tracks.map((t) => t.mid),
        { force: true },
      );
    } catch (e) {
      // A session or track Cloudflare no longer knows has nothing left to
      // close; anything else is retried.
      const status = (e as { status?: number | null }).status ?? null;
      ok = status === 404 || status === 410 || status === 400;
      if (!ok) this.logger.warn(`close tracks failed: ${(e as Error).message}`);
    }
    const giveUp = !ok && c.cleanupAttempts + 1 >= CLEANUP_MAX_ATTEMPTS;
    if (!ok && !giveUp) {
      await this.prisma.liveRtcConnection.update({
        where: { id: c.id },
        data: { cleanupAttempts: { increment: 1 } },
      });
      return false;
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.liveRtcTrack.updateMany({
        where: { connectionId: c.id, closedAt: null },
        data: { closedAt: now },
      }),
      this.prisma.liveRtcConnection.updateMany({
        where: { id: c.id, closedAt: null },
        data: {
          closedAt: now,
          ...(giveUp ? { closeReason: `${c.closeReason ?? reason}:cleanup-abandoned` } : {}),
        },
      }),
    ]);
    return true;
  }
}
