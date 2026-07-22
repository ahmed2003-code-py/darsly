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

const MAX_ATTEMPTS = 3;

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

  /** Enqueue a job. Rejects if the feature is off, a job is already active for
   *  this academy, or the monthly AI budget is exhausted. */
  async enqueue(academyId: string, type: AiJobType, input: Prisma.InputJsonValue = {}): Promise<AiJob> {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException('AI features are currently disabled');
    }
    if (await this.hasActiveJob(academyId)) {
      throw new ConflictException('A generation job is already in progress for this academy');
    }
    await this.assertWithinBudget();
    return this.prisma.aiJob.create({ data: { academyId, type, input, status: 'QUEUED' } });
  }

  /** Fetch a job scoped to an academy (status polling); null if not theirs. */
  getForAcademy(academyId: string, jobId: string): Promise<AiJob | null> {
    return this.prisma.aiJob.findFirst({ where: { id: jobId, academyId } });
  }

  hasActiveJob(academyId: string): Promise<boolean> {
    return this.prisma.aiJob
      .count({ where: { academyId, status: { in: ['QUEUED', 'RUNNING'] } } })
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
    const lease = new Date(Date.now() + leaseMs);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "AiJob"
      SET status = 'RUNNING'::"AiJobStatus",
          "leaseExpiresAt" = ${lease},
          attempts = attempts + 1,
          "updatedAt" = now()
      WHERE id = (
        SELECT id FROM "AiJob"
        WHERE status = 'QUEUED'::"AiJobStatus"
           OR (status = 'RUNNING'::"AiJobStatus" AND "leaseExpiresAt" < now())
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

  async succeed(jobId: string, result: { costCents?: number; resultSnapshotId?: string }): Promise<void> {
    await this.prisma.aiJob.update({
      where: { id: jobId },
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
   *  everything else is terminal. */
  async fail(jobId: string, err: { message: string; errorClass: AiErrorClass }): Promise<void> {
    const job = await this.prisma.aiJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const retry = err.errorClass === 'RETRYABLE' && job.attempts < MAX_ATTEMPTS;
    await this.prisma.aiJob.update({
      where: { id: jobId },
      data: {
        status: retry ? 'QUEUED' : 'FAILED',
        error: err.message.slice(0, 1000),
        errorClass: err.errorClass,
        leaseExpiresAt: null,
      },
    });
  }

  /** Admin: re-queue a FAILED job for another attempt (fresh attempt counter). */
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
