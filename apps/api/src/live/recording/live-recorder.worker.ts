import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LiveRecording, Prisma } from '@prisma/client';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import type { Browser, Page } from 'puppeteer-core';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageProvider } from '../../storage/storage.provider';
import { VideoProcessingService } from '../../video/video-processing.service';
import { LIVE_MAX_DURATION_MIN } from '../live-timing';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CF_STUN } from '../providers/cloudflare-realtime.client';
import { LiveRtcService } from '../rtc/live-rtc.service';
import { finalizeRecording } from './recording-finalize';
import { RECORDER_PAGE } from './recorder-page';
import { LiveRecordingService } from './live-recording.service';

/** How long a claim lasts without a heartbeat before another recorder may take over. */
export const RECORDER_LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const TICK_MS = 3_000;
/** A recording restarted more than this many times is given up on. */
export const RECORDER_MAX_ATTEMPTS = 6;

export function recorderConfig(env: NodeJS.ProcessEnv = process.env) {
  const segMin = Number(env.LIVE_RECORDER_SEGMENT_MIN);
  const conc = Number(env.LIVE_RECORDER_CONCURRENCY);
  return {
    enabled: env.LIVE_RECORDER_ENABLED === 'true',
    chromePath: env.CHROME_PATH?.trim() || undefined,
    dir: env.LIVE_RECORDER_DIR?.trim() || path.join(tmpdir(), 'darsly-live-rec'),
    segmentMs: (Number.isFinite(segMin) && segMin > 0 ? segMin : 10) * 60_000,
    concurrency: Number.isInteger(conc) && conc > 0 ? conc : 2,
  };
}

/** The database clock in UTC, to match what Prisma writes (see `claim`). */
const UTC_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** Where a recording's pieces live in object storage (never served). */
export const segmentKey = (recId: string, n: number) => `source/live-rec/${recId}/seg-${n}.webm`;
export const finalKey = (recId: string) => `source/live-rec/${recId}/final.webm`;

interface Job {
  rec: LiveRecording;
  page: Page | null;
  connectionId: string | null;
  cfSessionId: string | null;
  seg: number;
  bytes: number;
  startedAt: number;
  lost: boolean;
  uploads: Promise<unknown>[];
  hb?: ReturnType<typeof setInterval>;
}

/**
 * Darsly's recorder for Cloudflare classes.
 *
 * A worker, not a request: it claims REQUESTED recordings from the database
 * (FOR UPDATE SKIP LOCKED — several recorders share the work), joins each
 * class as a receive-only participant in headless Chrome (RECORDER_PAGE),
 * and writes what it hears and sees to disk in pieces. Every piece is
 * uploaded to object storage as soon as it closes.
 *
 * A claim is a lease, renewed by a heartbeat. A recorder that crashes, or a
 * container that is replaced, stops renewing it; the next recorder to look
 * takes the recording over and carries on in a new piece. What is lost is the
 * piece that was being written — minutes, not the lesson.
 *
 * It stops when the teacher stops it, when the class ends (by the teacher,
 * the clock or a cancellation), or at the longest a class can run. Then the
 * pieces are joined (ffmpeg), uploaded, and handed to the existing video
 * pipeline — VideoAsset → VideoJob → encrypted HLS — in one transaction.
 *
 * Needs Chrome (CHROME_PATH) and ffmpeg; off unless LIVE_RECORDER_ENABLED=true.
 * Meant for its own service (Dockerfile.recorder), so a recorder's CPU never
 * competes with the API's.
 */
@Injectable()
export class LiveRecorderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LiveRecorder');
  readonly workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  readonly cfg = recorderConfig();
  private browser: Browser | null = null;
  /** Replaceable in tests (it runs ffmpeg). */
  finalizeFn: typeof finalizeRecording = finalizeRecording;
  private readonly jobs = new Map<string, Job>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
    private readonly video: VideoProcessingService,
    private readonly cloudflare: CloudflareLiveProvider,
    private readonly rtc: LiveRtcService,
    private readonly recordings: LiveRecordingService,
  ) {}

  /** Whether this instance records (needs Chrome); finishing work runs anyway. */
  private capture = false;

  onModuleInit() {
    // Joining pieces, uploading and following the video pipeline need ffmpeg
    // and storage, not a browser — so every instance does that part, and a
    // finished recording never waits for the recorder service to be up.
    // LIVE_RECORDING_FINALIZE_ENABLED=false opts an instance out.
    const finalize = (process.env.LIVE_RECORDING_FINALIZE_ENABLED ?? 'true') === 'true';
    this.capture = this.cfg.enabled && !!this.cfg.chromePath;
    if (this.cfg.enabled && !this.cfg.chromePath) {
      this.logger.error('LIVE_RECORDER_ENABLED=true but CHROME_PATH is not set — not capturing');
    }
    if (!this.capture && !finalize) {
      this.logger.log('recorder off (capture and finalize disabled)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.log(
      this.capture
        ? `recorder started worker=${this.workerId} concurrency=${this.cfg.concurrency} segment=${this.cfg.segmentMs / 60000}min`
        : `recording finalizer started worker=${this.workerId} (capture off)`,
    );
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Leases are left to expire: another recorder takes over what this one
    // was doing. Closing the browser ends the pages without finalizing.
    await this.browser?.close().catch(() => undefined);
  }

  /** One pass: claim what there is room for, finish what is owed, catch up the pipeline. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.capture && this.jobs.size < this.cfg.concurrency) {
        const rec = await this.claim();
        if (!rec) break;
        if (this.jobs.has(rec.id)) break; // never twice in one worker
        void this.record(rec);
      }
      const owed = await this.claimFinalize();
      if (owed) await this.finalize(owed);
      await this.recordings.syncProcessing();
    } catch (e) {
      this.logger.error(`recorder tick: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** A recording to make: new, or one whose recorder stopped renewing its lease. */
  async claim(): Promise<LiveRecording | null> {
    // UTC explicitly: these columns are timestamps without a zone, written by
    // Prisma in UTC. `now()` alone would be stored in the database's own time
    // zone — and on a server that is not UTC every lease would look expired
    // (or everlasting) by the offset. Seen on a UTC+3 database: the recorder
    // re-claimed its own running recording on every tick.
    const [rec] = await this.prisma.$queryRaw<LiveRecording[]>(Prisma.sql`
      UPDATE "LiveRecording" r SET
        status = 'RECORDING',
        "leaseOwner" = ${this.workerId},
        "leaseUntil" = ${UTC_NOW} + make_interval(secs => ${RECORDER_LEASE_MS / 1000}),
        "heartbeatAt" = ${UTC_NOW},
        attempts = r.attempts + 1,
        "startedAt" = COALESCE(r."startedAt", ${UTC_NOW}),
        "claimedAt" = COALESCE(r."claimedAt", ${UTC_NOW}),
        "updatedAt" = ${UTC_NOW}
      WHERE r.id = (
        SELECT id FROM "LiveRecording"
        WHERE ((status = 'REQUESTED' AND "stopRequestedAt" IS NULL)
           OR (status IN ('RECORDING', 'STOPPING') AND "leaseUntil" < ${UTC_NOW}))
          AND NOT (id = ANY(${[...this.jobs.keys(), ''] as string[]}))
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING r.*`);
    if (!rec) return null;
    if (rec.attempts > RECORDER_MAX_ATTEMPTS) {
      // Kept restarting: whatever was uploaded is still worth finishing.
      await this.toFinalize(rec.id, 'RECORDER_GAVE_UP');
      return null;
    }
    return rec;
  }

  /** Record one claimed recording until it has to stop. */
  async record(rec: LiveRecording): Promise<void> {
    const job: Job = {
      rec,
      page: null,
      connectionId: null,
      cfSessionId: null,
      seg: rec.segments,
      bytes: Number(rec.sizeBytes),
      startedAt: rec.startedAt?.getTime() ?? Date.now(),
      lost: false,
      uploads: [],
    };
    this.jobs.set(rec.id, job);
    const dir = path.join(this.cfg.dir, rec.id);
    let reason = 'unknown';
    try {
      await fs.mkdir(dir, { recursive: true });
      const session = await this.prisma.liveSession.findUnique({
        where: { id: rec.sessionId },
        select: { status: true, roomName: true, deletedAt: true, provider: true },
      });
      if (!session || session.provider !== 'CLOUDFLARE') {
        await this.fail(rec.id, 'NOT_A_DARSLY_CLASS');
        return;
      }
      if (session.status !== 'LIVE' || session.roomName !== rec.roomName || session.deletedAt) {
        // The class ended before (or while) the recorder was away.
        await this.toFinalize(rec.id, 'CLASS_ENDED');
        return;
      }
      // The recorder's own connection to the class: receive-only.
      job.cfSessionId = await this.cloudflare.client.newSession();
      const conn = await this.prisma.liveRtcConnection.create({
        data: {
          sessionId: rec.sessionId,
          roomName: rec.roomName,
          userId: `recorder:${rec.id}`,
          role: 'RECORDER',
          purpose: 'RECEIVE',
          cfSessionId: job.cfSessionId,
        },
        select: { id: true },
      });
      job.connectionId = conn.id;
      await this.prisma.liveRecording.update({
        where: { id: rec.id },
        data: { segments: job.seg + 1 },
      });
      const page = await this.openPage(job, dir);
      job.page = page;
      job.hb = setInterval(() => void this.heartbeat(job), HEARTBEAT_MS);
      this.logger.log(
        `live.rec.recording liveSession=${rec.sessionId} recording=${rec.id} worker=${this.workerId} segment=${job.seg} attempt=${rec.attempts}`,
      );
      await page.evaluate((a) => (window as any).__start(a), {
        iceServers: [CF_STUN],
        segmentMs: this.cfg.segmentMs,
      });
      const done = (await page.evaluate(() => (window as any).__finished)) as { reason: string };
      reason = done.reason;
    } catch (e) {
      reason = `crash: ${(e as Error).message}`;
      job.lost = true;
      this.logger.warn(`live.rec.crash recording=${rec.id}: ${(e as Error).message}`);
    } finally {
      if (job.hb) clearInterval(job.hb);
      await job.page?.close().catch(() => undefined);
      if (job.connectionId) {
        await this.cloudflare
          .closeConnections([job.connectionId], 'recorder-done')
          .catch(() => undefined);
      }
      // The piece being written goes up too (whatever there is of it).
      this.uploadSegment(job, dir, job.seg);
      await Promise.allSettled(job.uploads);
      this.jobs.delete(rec.id);
    }
    if (job.lost) {
      this.logger.warn(`live.rec.lost recording=${rec.id} reason=${reason} segment=${job.seg}`);
      // Hand it back at once rather than waiting out the lease: the next
      // tick (here or elsewhere) takes it over in a new piece.
      await this.prisma.liveRecording.updateMany({
        where: { id: rec.id, leaseOwner: this.workerId },
        data: { leaseUntil: new Date(0) },
      });
      return;
    }
    this.logger.log(`live.rec.stopped recording=${rec.id} reason=${reason}`);
    await this.toFinalize(rec.id, null);
  }

  private async openPage(job: Job, dir: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    page.on('error', () => (job.lost = true));
    page.on('pageerror', (e) => this.logger.warn(`recorder page: ${(e as Error).message}`));
    await page.exposeFunction('__log', (m: string) =>
      this.logger.debug?.(`recorder[${job.rec.id}]: ${m}`),
    );
    await page.exposeFunction('__chunk', async (b64: string) => {
      if (!job.bytes) {
        // The first media: when capture really began (a takeover keeps the
        // first recorder's time).
        await this.prisma.liveRecording
          .updateMany({
            where: { id: job.rec.id, captureStartedAt: null },
            data: { captureStartedAt: new Date() },
          })
          .catch(() => undefined);
      }
      const buf = Buffer.from(b64, 'base64');
      await fs.appendFile(path.join(dir, `seg-${job.seg}.webm`), buf);
      job.bytes += buf.length;
    });
    await page.exposeFunction('__segment', async () => {
      const closed = job.seg;
      job.seg += 1;
      await this.prisma.liveRecording.update({
        where: { id: job.rec.id },
        data: { segments: job.seg + 1 },
      });
      this.uploadSegment(job, dir, closed);
    });
    await page.exposeFunction('__state', () => this.pageState(job));
    await page.exposeFunction('__lost', (why: string) => {
      this.logger.warn(`live.rec.page-lost recording=${job.rec.id} reason=${why}`);
      job.lost = true;
    });
    await page.exposeFunction('__cf', (op: string, args: any) => this.pageCf(job, op, args));
    await page.setContent(RECORDER_PAGE);
    return page;
  }

  /** What the page should be receiving now, and whether it should stop. */
  private async pageState(job: Job) {
    const rec = await this.prisma.liveRecording.findUnique({
      where: { id: job.rec.id },
      select: { stopRequestedAt: true, leaseOwner: true, status: true },
    });
    if (!rec || rec.leaseOwner !== this.workerId) {
      this.logger.warn(
        `live.rec.lease-lost recording=${job.rec.id} owner=${rec?.leaseOwner ?? 'none'}`,
      );
      job.lost = true;
      return { stop: true, reason: 'lease-lost', tracks: [] };
    }
    if (rec.stopRequestedAt) return { stop: true, reason: 'requested', tracks: [] };
    const s = await this.prisma.liveSession.findUnique({
      where: { id: job.rec.sessionId },
      select: { status: true, roomName: true, deletedAt: true },
    });
    if (!s || s.status !== 'LIVE' || s.roomName !== job.rec.roomName || s.deletedAt) {
      return { stop: true, reason: 'class-ended', tracks: [] };
    }
    if (Date.now() - job.startedAt > LIVE_MAX_DURATION_MIN * 60_000) {
      return { stop: true, reason: 'max-duration', tracks: [] };
    }
    const tracks = await this.rtc.openTracks(job.rec.sessionId, job.rec.roomName);
    return {
      stop: false,
      tracks: tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        userId: t.userId,
        role: t.connection.role,
      })),
    };
  }

  /** The page's signalling, done here with the server's credentials. */
  private async pageCf(job: Job, op: string, args: any) {
    const cf = this.cloudflare.client;
    const sid = job.cfSessionId!;
    if (op === 'subscribe') {
      const open = await this.rtc.openTracks(job.rec.sessionId, job.rec.roomName);
      const want = (args.trackIds as string[])
        .map((id) => open.find((t) => t.id === id))
        .filter((t): t is (typeof open)[number] => !!t);
      if (!want.length) return { tracks: [] };
      const r = await cf.pullTracks(
        sid,
        want.map((t) => ({
          sessionId: t.connection.cfSessionId,
          trackName: t.trackName,
          // The recording keeps the sharp layer of the teacher's camera.
          ...(t.kind === 'VIDEO' && t.connection.role === 'TEACHER' ? { preferredRid: 'h' } : {}),
        })),
      );
      return {
        requiresImmediateRenegotiation: !!r.requiresImmediateRenegotiation,
        sessionDescription: r.sessionDescription ?? null,
        tracks: want.map((t, i) => ({
          trackId: t.id,
          mid: r.tracks?.[i]?.mid ?? null,
          error: r.tracks?.[i]?.errorCode ?? null,
        })),
      };
    }
    if (op === 'renegotiate') {
      await cf.renegotiate(sid, args.answer);
      return { ok: true };
    }
    if (op === 'close') {
      const r = await cf.closeTracks(sid, args.mids, {
        force: false,
        sessionDescription: args.offer,
      });
      return { sessionDescription: r.sessionDescription ?? null };
    }
    throw new Error(`unknown op ${op}`);
  }

  private async heartbeat(job: Job) {
    const r = await this.prisma.liveRecording
      .updateMany({
        where: {
          id: job.rec.id,
          leaseOwner: this.workerId,
          status: { in: ['RECORDING', 'STOPPING'] },
        },
        data: {
          leaseUntil: new Date(Date.now() + RECORDER_LEASE_MS),
          heartbeatAt: new Date(),
          sizeBytes: BigInt(job.bytes),
          durationSec: Math.round((Date.now() - job.startedAt) / 1000),
        },
      })
      .catch(() => ({ count: -1 }));
    // Someone else holds it now (this recorder stalled past its lease): stop
    // writing, without finalizing — the new holder carries on.
    if (r.count === 0) {
      this.logger.warn(`live.rec.heartbeat-refused recording=${job.rec.id}`);
      job.lost = true;
    }
  }

  /** A closed piece goes to object storage at once; retried at finalize if this fails. */
  private uploadSegment(job: Job, dir: string, n: number) {
    const file = path.join(dir, `seg-${n}.webm`);
    const p = (async () => {
      try {
        const st = await fs.stat(file).catch(() => null);
        if (!st || !st.size) return;
        await this.storage.put(segmentKey(job.rec.id, n), createReadStream(file), {
          contentType: 'video/webm',
        });
      } catch (e) {
        this.logger.warn(
          `live.rec.segment-upload-failed recording=${job.rec.id} seg=${n}: ${(e as Error).message}`,
        );
      }
    })();
    job.uploads.push(p);
  }

  private async toFinalize(id: string, note: string | null) {
    await this.prisma.liveRecording.updateMany({
      where: { id, status: { in: ['REQUESTED', 'RECORDING', 'STOPPING'] } },
      data: {
        status: 'UPLOADING',
        stoppedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
        ...(note ? { error: note } : {}),
      },
    });
  }

  private async fail(id: string, error: string) {
    await this.prisma.liveRecording.update({ where: { id }, data: { status: 'FAILED', error } });
    await this.mirror(id);
  }

  /** A recording waiting to be joined and handed over — claimed like a recording. */
  async claimFinalize(): Promise<LiveRecording | null> {
    const [rec] = await this.prisma.$queryRaw<LiveRecording[]>(Prisma.sql`
      UPDATE "LiveRecording" r SET
        "leaseOwner" = ${this.workerId},
        "leaseUntil" = ${UTC_NOW} + make_interval(secs => 300),
        "updatedAt" = ${UTC_NOW}
      WHERE r.id = (
        SELECT id FROM "LiveRecording"
        WHERE status = 'UPLOADING' AND ("leaseUntil" IS NULL OR "leaseUntil" < ${UTC_NOW})
        ORDER BY "updatedAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
      RETURNING r.*`);
    return rec ?? null;
  }

  /**
   * Join the pieces, upload the result, and hand it to the video pipeline —
   * the asset and its job created together, or neither. Any failure leaves
   * the recording UPLOADING (with the reason) to be tried again.
   */
  async finalize(rec: LiveRecording): Promise<void> {
    const dir = path.join(this.cfg.dir, rec.id);
    try {
      await fs.mkdir(dir, { recursive: true });
      // Pieces recorded elsewhere (another recorder, a replaced container)
      // come back from storage; one that was never uploaded is lost.
      const missing: number[] = [];
      for (let n = 0; n < rec.segments; n++) {
        const file = path.join(dir, `seg-${n}.webm`);
        const local = await fs.stat(file).catch(() => null);
        if (local?.size) continue;
        if (await this.storage.exists(segmentKey(rec.id, n))) {
          const { stream } = await this.storage.getStream(segmentKey(rec.id, n));
          await pipeline(stream, createWriteStream(file));
        } else {
          missing.push(n);
        }
      }
      const out = await this.finalizeFn(dir).catch((e) => {
        if ((e as Error).message === 'NO_MEDIA') return null;
        throw e;
      });
      if (!out) {
        await this.fail(rec.id, 'NO_MEDIA');
        return;
      }
      await this.storage.put(finalKey(rec.id), createReadStream(out.file), {
        contentType: 'video/webm',
      });
      const handed = await this.prisma.$transaction(async (tx) => {
        const asset = await tx.videoAsset.create({
          data: {
            tenantId: rec.tenantId,
            originalKey: finalKey(rec.id),
            sizeBytes: BigInt(out.sizeBytes),
            durationSec: out.durationSec,
          },
        });
        const claimed = await tx.liveRecording.updateMany({
          where: { id: rec.id, status: 'UPLOADING', videoAssetId: null },
          data: {
            status: 'PROCESSING',
            videoAssetId: asset.id,
            handedAt: new Date(),
            sizeBytes: BigInt(out.sizeBytes),
            durationSec: out.durationSec,
            leaseOwner: null,
            leaseUntil: null,
            error: missing.length ? `PARTIAL: segments lost ${missing.join(',')}` : rec.error,
          },
        });
        // Another recorder finished it first: this attempt changes nothing.
        if (claimed.count === 0) throw new AlreadyHanded();
        await this.video.enqueue(asset.id, rec.tenantId, tx);
        return asset.id;
      });
      this.logger.log(
        `live.rec.handed recording=${rec.id} asset=${handed} bytes=${out.sizeBytes} duration=${out.durationSec}s segments=${rec.segments} lost=${missing.length}`,
      );
      // The pieces are in the joined file now.
      for (let n = 0; n < rec.segments; n++) {
        await this.storage.delete(segmentKey(rec.id, n)).catch(() => undefined);
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    } catch (e) {
      if (e instanceof AlreadyHanded) return;
      this.logger.warn(`live.rec.finalize-failed recording=${rec.id}: ${(e as Error).message}`);
      await this.prisma.liveRecording.updateMany({
        where: { id: rec.id, status: 'UPLOADING' },
        data: {
          error: `FINALIZE: ${(e as Error).message.slice(0, 300)}`,
          attempts: { increment: 1 },
          // Back off before the next try.
          leaseUntil: new Date(
            Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** Math.min(rec.attempts, 6)),
          ),
          leaseOwner: null,
        },
      });
    }
  }

  /** The class's recordingStatus follows its latest recording. */
  private async mirror(id: string) {
    const r = await this.prisma.liveRecording.findUnique({ where: { id } });
    if (!r) return;
    const latest = await this.prisma.liveRecording.findFirst({
      where: { sessionId: r.sessionId },
      orderBy: { createdAt: 'desc' },
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

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    const puppeteer = await import('puppeteer-core');
    this.browser = await puppeteer.launch({
      executablePath: this.cfg.chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        // A recorder must not be throttled as a background tab would be.
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-dev-shm-usage',
      ],
    });
    this.browser.on('disconnected', () => {
      this.browser = null;
      for (const j of this.jobs.values()) j.lost = true;
    });
    return this.browser;
  }
}

class AlreadyHanded extends Error {}
