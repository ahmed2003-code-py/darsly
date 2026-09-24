import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AiJob, AiJobType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AcademySiteConfig } from '../academy-site.config';
import { AiErrorClass } from '../ai/ai-job.error';

export const MAX_ATTEMPTS = 3;

/**
 * DB-backed job queue for AI work (no Redis). Jobs are claimed atomically with
 * FOR UPDATE SKIP LOCKED so multiple API replicas can process safely, and the
 * same claim query re-acquires RUNNING jobs whose lease expired (crash
 * recovery), which doubles as the stuck-job sweep.
 */
@Injectable()
export class AiJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AcademySiteConfig,
  ) {}

  /**
   * Enqueue a job. Rejects if the feature is off, a job is already active for
   * this academy, or the monthly AI budget is exhausted.
   *
   * `conflictsWith` narrows what counts as "already active". One academy-wide
   * lock was right while site generation was the only thing here — two
   * generations at once rewrite the same page. It is wrong across unrelated
   * features: a teacher scanning an exam would be refused because somebody
   * else was regenerating the academy's site, and vice versa. A caller that
   * passes its own type gets a lock over that type alone; passing nothing
   * keeps the academy-wide behaviour every existing caller relies on.
   */
  async enqueue(
    academyId: string,
    type: AiJobType,
    input: Prisma.InputJsonValue = {},
    opts: { conflictsWith?: AiJobType[] } = {},
  ): Promise<AiJob> {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException('AI features are currently disabled');
    }
    if (await this.hasActiveJob(academyId, opts.conflictsWith)) {
      throw new ConflictException('A generation job is already in progress for this academy');
    }
    await this.assertWithinBudget();
    return this.prisma.aiJob.create({ data: { academyId, type, input, status: 'QUEUED' } });
  }

  /** Fetch a job scoped to an academy (status polling); null if not theirs. */
  getForAcademy(academyId: string, jobId: string): Promise<AiJob | null> {
    return this.prisma.aiJob.findFirst({ where: { id: jobId, academyId } });
  }

  hasActiveJob(academyId: string, types?: AiJobType[]): Promise<boolean> {
    return this.prisma.aiJob
      .count({
        where: {
          academyId,
          status: { in: ['QUEUED', 'RUNNING'] },
          ...(types?.length ? { type: { in: types } } : {}),
        },
      })
      .then((n) => n > 0);
  }

  /** Month-to-date platform AI spend must stay under the configured ceiling
   *  (0 = uncapped). */
  async assertWithinBudget(): Promise<void> {
    const cap = this.config.monthlyBudgetCents;
    if (cap <= 0) return;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const agg = await this.prisma.aiJob.aggregate({
      _sum: { costCents: true },
      where: { createdAt: { gte: monthStart } },
    });
    const spent = agg._sum.costCents ?? 0;
    if (spent >= cap) {
      throw new ServiceUnavailableException('Monthly AI budget reached — try again next month');
    }
  }

  /**
   * Atomically claim the next runnable job. Picks a QUEUED job, or a RUNNING one
   * whose lease expired (crashed worker), sets it RUNNING with a fresh lease and
   * increments attempts. Returns null when nothing is claimable.
   */
  async claimNext(leaseMs: number): Promise<AiJob | null> {
    // Every value in these columns is UTC with no zone attached — that is how
    // Prisma writes a Date (renewLease, fail, the retry's nextRunAt). Raw SQL
    // has to speak the same language: a JS Date bound here was converted to
    // the session's zone, and a bare now() compares in it too. On a database
    // whose zone is not UTC the first heartbeat therefore put the lease hours
    // in the past, and a second worker picked the job up while the first was
    // still running it — the same exam read, and billed, twice.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "AiJob"
      SET status = 'RUNNING'::"AiJobStatus",
          "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + ${leaseMs} * interval '1 millisecond',
          attempts = attempts + 1,
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE id = (
        SELECT id FROM "AiJob"
        WHERE status = 'QUEUED'::"AiJobStatus"
           OR (status = 'RUNNING'::"AiJobStatus" AND "leaseExpiresAt" < (now() AT TIME ZONE 'UTC'))
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    if (!rows.length) return null;
    return this.prisma.aiJob.findUnique({ where: { id: rows[0].id } });
  }

  /** Extend the lease of a running job (worker heartbeat for long runs). */
  async renewLease(jobId: string, leaseMs: number): Promise<void> {
    await this.prisma.aiJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  }

  setStage(jobId: string, stage: string): Promise<unknown> {
    return this.prisma.aiJob.update({ where: { id: jobId }, data: { stage } });
  }

  async succeed(
    jobId: string,
    result: { costCents?: number; resultSnapshotId?: string },
  ): Promise<void> {
    // updateMany on RUNNING: a job stopped by its owner while this call was
    // in flight stays stopped, instead of reappearing as SUCCEEDED.
    await this.prisma.aiJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: {
        status: 'SUCCEEDED',
        leaseExpiresAt: null,
        error: null,
        errorClass: null,
        ...(result.costCents != null ? { costCents: result.costCents } : {}),
        ...(result.resultSnapshotId ? { resultSnapshotId: result.resultSnapshotId } : {}),
      },
    });
  }

  /** Fail a job. RETRYABLE errors below the attempt cap go back to QUEUED;
   *  everything else is terminal. Not academy-scoped: jobId here is always
   *  `job.id` from a job this worker itself claimed via claimNext(), never
   *  user input. */
  async fail(jobId: string, err: { message: string; errorClass: AiErrorClass }): Promise<void> {
    const job = await this.prisma.aiJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    // A stopped job is not failed and is never retried.
    if (job.status === 'CANCELED') return;
    const retry = err.errorClass === 'RETRYABLE' && job.attempts < MAX_ATTEMPTS;
    await this.prisma.aiJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: {
        status: retry ? 'QUEUED' : 'FAILED',
        error: err.message.slice(0, 1000),
        errorClass: err.errorClass,
        leaseExpiresAt: null,
      },
    });
  }

  /** Admin: re-queue a FAILED job for another attempt (fresh attempt counter).
   *  Intentionally not academy-scoped: the only caller is
   *  AdminAcademyStudioController, gated `@Roles(Role.SUPER_ADMIN)` at the
   *  controller level — a platform admin is meant to manage any academy's
   *  jobs here, same as every other route on that controller. */
  async rerunFailed(jobId: string): Promise<AiJob> {
    const job = await this.prisma.aiJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'FAILED') {
      throw new ConflictException(`Only FAILED jobs can be rerun (this one is ${job.status})`);
    }
    if (await this.hasActiveJob(job.academyId)) {
      throw new ConflictException('This academy already has an active job');
    }
    return this.prisma.aiJob.update({
      where: { id: jobId },
      data: { status: 'QUEUED', attempts: 0, error: null, errorClass: null, leaseExpiresAt: null },
    });
  }

  /**
   * Stop a job whether or not it has started — for work its owner has put
   * down.
   *
   * `cancel` below refuses a RUNNING job, which is right for a site
   * generation nobody should interrupt, and was wrong for an exam a teacher
   * pressed "stop" on: the import became CANCELED while its job stayed
   * RUNNING, so the academy-wide lock held until the job finished — and every
   * new upload was refused with "your other exam is still being prepared",
   * pointing at the one just stopped. A stopped job leaves the lock at once;
   * the call in flight finishes and is discarded (its handler checks the
   * import between pages, and succeed/fail do not touch a CANCELED job).
   */
  async stop(academyId: string, jobId: string): Promise<void> {
    await this.prisma.aiJob.updateMany({
      where: { id: jobId, academyId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELED', leaseExpiresAt: null },
    });
  }

  /** Cancel a queued job. A job that is already RUNNING cannot be cleanly
   *  cancelled mid-call. */
  async cancel(academyId: string, jobId: string): Promise<AiJob> {
    const job = await this.prisma.aiJob.findFirst({ where: { id: jobId, academyId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'QUEUED') {
      throw new ConflictException(`Cannot cancel a ${job.status.toLowerCase()} job`);
    }
    return this.prisma.aiJob.update({ where: { id: jobId }, data: { status: 'CANCELED' } });
  }
}
