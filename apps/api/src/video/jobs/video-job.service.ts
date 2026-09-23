import { Injectable, Logger } from '@nestjs/common';
import { Prisma, VideoJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** How many times a RETRYABLE failure is re-attempted before it is given up on. */
export const MAX_ATTEMPTS = 3;

/** First retry waits this long; each subsequent one doubles. */
const BASE_BACKOFF_MS = 30_000;
/** However many attempts have failed, never wait longer than this. */
const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * A failure the work can recover from on its own (a storage timeout, a disk
 * that was briefly full) versus one that will fail identically forever (a
 * corrupt source, an unsupported codec, an asset that no longer exists).
 * Retrying the second kind just burns a core three times.
 */
export type VideoErrorClass = 'RETRYABLE' | 'TERMINAL';

export class VideoJobError extends Error {
  constructor(
    message: string,
    readonly errorClass: VideoErrorClass,
  ) {
    super(message);
    this.name = 'VideoJobError';
  }
}

/**
 * The queue for video packaging: Postgres rows, claimed with FOR UPDATE SKIP
 * LOCKED.
 *
 * Modelled closely on `academy-site/jobs/ai-job.service.ts`, which has been
 * claiming AI work across replicas this way for a while — deliberately the
 * same shape so there is one claiming pattern in this codebase to understand
 * rather than two. What is *not* reused is that service's policy: it refuses a
 * second job per academy and checks an AI budget, both of which are right for
 * site generation and wrong here (a teacher uploading three lessons must not
 * find the second one refused).
 *
 * The one addition is `nextRunAt`. AiJob retries a RETRYABLE failure by putting
 * it straight back to QUEUED, so the next 3-second poll runs it again and it
 * fails the same way; backoff gives whatever broke a chance to stop being
 * broken.
 */
@Injectable()
export class VideoJobService {
  private readonly logger = new Logger(VideoJobService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Promise that an asset will be packaged.
   *
   * Idempotent, and enforced by the database rather than by a read-then-write
   * that two concurrent callers would both pass: a partial unique index allows
   * only one QUEUED-or-RUNNING job per asset, so a duplicate enqueue returns
   * the job that already exists instead of creating a second one. A finished
   * job does not block a new one, which is what makes a deliberate re-package
   * possible.
   *
   * Accepts an optional transaction client so the caller can create the asset
   * and its job together — an asset with no job is work that will never
   * happen, and a job with no asset is a worker that will fail forever.
   */
  async enqueue(
    videoAssetId: string,
    tenantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<VideoJob> {
    const db = tx ?? this.prisma;
    try {
      return await db.videoJob.create({
        data: { videoAssetId, tenantId, type: 'PACKAGE', status: 'QUEUED' },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await db.videoJob.findFirst({
          where: { videoAssetId, status: { in: ['QUEUED', 'RUNNING'] } },
        });
        if (existing) {
          this.logger.log(`asset ${videoAssetId} already has job ${existing.id}; not duplicating`);
          return existing;
        }
      }
      throw e;
    }
  }

  /**
   * Take the oldest due job and mark it ours for `leaseMs`.
   *
   * One statement, so two replicas polling at the same moment cannot both take
   * the same row: SKIP LOCKED makes the loser step over it rather than wait.
   *
   * The same query is the crash recovery. A RUNNING job whose lease has expired
   * is, by definition, one whose worker died without finishing — a redeploy
   * mid-ffmpeg, an OOM kill — so it becomes claimable again. That single `OR`
   * is what turns "the deploy ate my upload" into "the upload was a few minutes
   * late".
   */
  async claimNext(leaseMs: number): Promise<VideoJob | null> {
    const lease = new Date(Date.now() + leaseMs);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "VideoJob"
      SET status = 'RUNNING'::"VideoJobStatus",
          "leaseExpiresAt" = ${lease},
          attempts = attempts + 1,
          "updatedAt" = now()
      WHERE id = (
        SELECT id FROM "VideoJob"
        WHERE (status = 'QUEUED'::"VideoJobStatus" AND "nextRunAt" <= now())
           OR (status = 'RUNNING'::"VideoJobStatus" AND "leaseExpiresAt" < now())
        ORDER BY "nextRunAt" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    if (!rows.length) return null;
    return this.prisma.videoJob.findUnique({ where: { id: rows[0].id } });
  }

  /**
   * Push the lease out while the work is still running.
   *
   * Packaging a long lesson can take longer than any lease worth setting, and
   * without a heartbeat the job would be declared abandoned and picked up by a
   * second worker while the first is still encoding it.
   */
  async renewLease(jobId: string, leaseMs: number): Promise<void> {
    await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  }

  async succeed(jobId: string): Promise<void> {
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: { status: 'SUCCEEDED', leaseExpiresAt: null, error: null, errorClass: null },
    });
  }

  /**
   * Record a failure, and decide whether it gets another go.
   *
   * Returns whether the job was re-queued, so the worker knows whether the
   * asset should be marked FAILED for the teacher — a job that will be retried
   * in thirty seconds has not failed yet, and saying so on screen would be a
   * lie the next attempt has to undo.
   */
  async fail(
    jobId: string,
    err: { message: string; errorClass: VideoErrorClass },
  ): Promise<boolean> {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) return false;

    const retry = err.errorClass === 'RETRYABLE' && job.attempts < MAX_ATTEMPTS;
    if (retry) {
      // attempts is already incremented by the claim, so attempt 1 waits
      // BASE, attempt 2 waits 2×BASE, and so on — capped.
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          status: 'QUEUED',
          leaseExpiresAt: null,
          nextRunAt: new Date(Date.now() + delay),
          error: err.message.slice(0, 1000),
          errorClass: err.errorClass,
        },
      });
      this.logger.warn(
        `job ${jobId} retry ${job.attempts}/${MAX_ATTEMPTS} in ${delay}ms: ${err.message}`,
      );
      return true;
    }

    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        leaseExpiresAt: null,
        error: err.message.slice(0, 1000),
        errorClass: err.errorClass,
      },
    });
    this.logger.error(`job ${jobId} failed permanently [${err.errorClass}]: ${err.message}`);
    return false;
  }

  /**
   * Put a dead job back in the queue.
   *
   * The dead-letter handling: a FAILED job is kept, not deleted, so someone can
   * read why before deciding to run it again. Explicit and one asset at a time
   * — there is deliberately no sweep that decides on its own to re-run
   * everything that ever failed.
   */
  async requeue(jobId: string): Promise<VideoJob> {
    return this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        status: 'QUEUED',
        attempts: 0,
        nextRunAt: new Date(),
        leaseExpiresAt: null,
        error: null,
        errorClass: null,
      },
    });
  }
}
