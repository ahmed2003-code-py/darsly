import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { CAPTURE_LEASE_TTL_MS, transcriptCaptureState } from './capture-state';
export { CAPTURE_LEASE_TTL_MS } from './capture-state';
import { validPieceSeq } from './lesson-transcription';

/** The most pieces one heartbeat may report. */
const MAX_PIECES_PER_REPORT = 200;
const MANIFEST_STATES = new Set(['QUEUED', 'SILENT', 'DROPPED']);

export interface PieceReport {
  seq: number;
  durationMs: number;
  state: 'QUEUED' | 'SILENT' | 'DROPPED';
  reason?: string;
  /** The lease the piece was made under (a piece recovered after a reload names its old one). */
  leaseId?: string;
}

export interface CaptureBeat {
  leaseId: string;
  tabId: string;
  audioOk?: boolean;
  audioProblem?: string | null;
  stats?: Record<string, number>;
  pieces?: PieceReport[];
}

/**
 * The one teacher tab that captures a class's audio, and what it says it made.
 *
 * The lesson's audio is captured in the teacher's own browser. Two tabs — a
 * laptop and a phone, or a page opened twice — both captured and both
 * uploaded, so every student's turn was transcribed twice. Now a tab claims
 * the class first; while it keeps beating, no other tab captures, and a piece
 * from one that lost the lease is refused. A tab that goes quiet for
 * CAPTURE_LEASE_TTL_MS (closed, crashed, offline) is replaced by the next one
 * to claim. A reload keeps its tab id (sessionStorage) and so its lease.
 *
 * The heartbeat also carries the tab's manifest — every piece it made, sent,
 * silent or given up on — and whether its audio is really running. That is
 * what lets a transcript be called complete only when it is (coverage.ts).
 */
@Injectable()
export class LiveCaptureService {
  private readonly logger = new Logger(LiveCaptureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  private async runOf(scope: LiveScope, id: string) {
    const s = await this.live.ownedSession(scope, id);
    if (s.provider !== 'CLOUDFLARE' || !s.roomName) {
      throw new ConflictException({ message: 'Not a Darsly-hosted class', code: 'NOT_CLOUDFLARE' });
    }
    return s;
  }

  /** The tab holding this run now, if any (beating within the TTL, not released). */
  activeLease(sessionId: string, roomName: string, now = Date.now()) {
    return this.prisma.liveCaptureLease.findFirst({
      where: {
        sessionId,
        roomName,
        releasedAt: null,
        lastBeatAt: { gt: new Date(now - CAPTURE_LEASE_TTL_MS) },
      },
      orderBy: { lastBeatAt: 'desc' },
    });
  }

  /**
   * Claim the class's capture for this tab. The same tab gets its lease back
   * (a reload); another tab is refused while the holder keeps beating.
   */
  async claim(scope: LiveScope, id: string, userId: string, tabId: string) {
    if (!tabId || tabId.length > 64) {
      throw new BadRequestException({ message: 'Bad tab id', code: 'BAD_TAB' });
    }
    const s = await this.runOf(scope, id);
    if (s.status !== 'LIVE') {
      throw new ConflictException({ message: 'The class is not running', code: 'NOT_LIVE' });
    }
    const roomName = s.roomName!;
    const lease = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-cap:${id}`}))`;
      const now = new Date();
      const held = await tx.liveCaptureLease.findFirst({
        where: {
          sessionId: id,
          roomName,
          releasedAt: null,
          lastBeatAt: { gt: new Date(now.getTime() - CAPTURE_LEASE_TTL_MS) },
        },
        orderBy: { lastBeatAt: 'desc' },
      });
      if (held && (held.userId !== userId || held.tabId !== tabId)) {
        throw new ConflictException({
          message: 'This class is being captured in another tab or device',
          code: 'CAPTURE_ELSEWHERE',
        });
      }
      if (held) {
        return tx.liveCaptureLease.update({ where: { id: held.id }, data: { lastBeatAt: now } });
      }
      // Leases that went quiet end where they were last heard from.
      const stale = await tx.liveCaptureLease.findMany({
        where: { sessionId: id, roomName, releasedAt: null },
        select: { id: true, lastBeatAt: true },
      });
      for (const l of stale) {
        await tx.liveCaptureLease.update({
          where: { id: l.id },
          data: { releasedAt: l.lastBeatAt },
        });
      }
      return tx.liveCaptureLease.create({
        data: { sessionId: id, roomName, userId, tabId },
      });
    });
    const capture = await transcriptCaptureState(this.prisma, id, roomName);
    this.logger.log(`live.capture.claimed liveSession=${id} lease=${lease.id} tab=${tabId}`);
    return { leaseId: lease.id, roomName, capturing: capture.active };
  }

  /** The holder's heartbeat: still here, what it made, whether its audio runs. */
  async beat(scope: LiveScope, id: string, userId: string, b: CaptureBeat) {
    await this.live.ownedSession(scope, id);
    const lease = await this.prisma.liveCaptureLease.findUnique({ where: { id: b.leaseId } });
    if (!lease || lease.sessionId !== id || lease.userId !== userId || lease.tabId !== b.tabId) {
      throw new ConflictException({ message: 'Not your capture', code: 'CAPTURE_LEASE_LOST' });
    }
    // Reports about what was already made are kept even from a lease that has
    // gone: those pieces were made under it, and the manifest is about them.
    await this.recordPieces(id, userId, lease, b.pieces ?? []);
    const now = Date.now();
    const lost =
      !!lease.releasedAt ||
      (lease.lastBeatAt.getTime() < now - CAPTURE_LEASE_TTL_MS &&
        !!(await this.activeLease(id, lease.roomName, now)));
    if (lost) {
      throw new ConflictException({ message: 'Not your capture', code: 'CAPTURE_LEASE_LOST' });
    }
    await this.prisma.liveCaptureLease.update({
      where: { id: lease.id },
      data: {
        lastBeatAt: new Date(now),
        ...(b.audioOk !== undefined ? { audioOk: b.audioOk } : {}),
        ...(b.audioProblem !== undefined
          ? { audioProblem: b.audioProblem?.slice(0, 120) ?? null }
          : {}),
        ...(b.stats ? { stats: sanitizeStats(b.stats) as Prisma.InputJsonValue } : {}),
      },
    });
    const capture = await transcriptCaptureState(this.prisma, id, lease.roomName);
    return { ok: true as const, capturing: capture.active };
  }

  /** The tab stopped capturing (capture off, left, class over): the lease ends here. */
  async release(scope: LiveScope, id: string, userId: string, b: CaptureBeat) {
    await this.live.ownedSession(scope, id);
    const lease = await this.prisma.liveCaptureLease.findUnique({ where: { id: b.leaseId } });
    if (!lease || lease.sessionId !== id || lease.userId !== userId) return { ok: true as const };
    await this.recordPieces(id, userId, lease, b.pieces ?? []);
    await this.prisma.liveCaptureLease.updateMany({
      where: { id: lease.id, releasedAt: null },
      data: {
        releasedAt: new Date(),
        ...(b.stats ? { stats: sanitizeStats(b.stats) as Prisma.InputJsonValue } : {}),
      },
    });
    return { ok: true as const };
  }

  /**
   * The manifest: one row per piece, keyed by its second. A piece moves
   * QUEUED → DROPPED when its upload is refused for good; SILENT is final. A
   * piece that names another lease of this class (recovered after a reload)
   * is filed under that lease's run.
   */
  private async recordPieces(
    sessionId: string,
    userId: string,
    lease: { id: string; roomName: string },
    pieces: PieceReport[],
  ) {
    if (!pieces.length) return;
    if (pieces.length > MAX_PIECES_PER_REPORT) {
      throw new BadRequestException({ message: 'Too many pieces', code: 'BAD_MANIFEST' });
    }
    const otherLeases = [
      ...new Set(pieces.map((p) => p.leaseId).filter((l): l is string => !!l && l !== lease.id)),
    ];
    const runOf = new Map<string, string>([[lease.id, lease.roomName]]);
    if (otherLeases.length) {
      const rows = await this.prisma.liveCaptureLease.findMany({
        where: { id: { in: otherLeases }, sessionId, userId },
        select: { id: true, roomName: true },
      });
      for (const r of rows) runOf.set(r.id, r.roomName);
    }
    for (const p of pieces) {
      if (
        !validPieceSeq(p.seq) ||
        !MANIFEST_STATES.has(p.state) ||
        !Number.isFinite(p.durationMs) ||
        p.durationMs < 0 ||
        p.durationMs > 30 * 60_000
      ) {
        continue;
      }
      const leaseId = p.leaseId && runOf.has(p.leaseId) ? p.leaseId : lease.id;
      const roomName = runOf.get(leaseId)!;
      const reason = p.reason?.slice(0, 120) ?? null;
      const durationMs = Math.round(p.durationMs);
      if (p.state === 'DROPPED') {
        // Only a piece still owed can be given up on; SILENT is final.
        const moved = await this.prisma.liveAudioManifest.updateMany({
          where: { sessionId, roomName, seq: p.seq, state: 'QUEUED' },
          data: { state: 'DROPPED', reason },
        });
        if (moved.count) continue;
      }
      await this.prisma.liveAudioManifest.upsert({
        where: { sessionId_roomName_seq: { sessionId, roomName, seq: p.seq } },
        create: { sessionId, roomName, seq: p.seq, durationMs, state: p.state, reason, leaseId },
        // Reported twice (a retried heartbeat): the first report stands.
        update: {},
      });
    }
  }
}

function sanitizeStats(stats: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats).slice(0, 20)) {
    if (/^[a-zA-Z]{1,32}$/.test(k) && Number.isFinite(v)) out[k] = Math.max(0, Math.round(v));
  }
  return out;
}
