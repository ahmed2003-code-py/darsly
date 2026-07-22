import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AiJob } from '@prisma/client';
import { AcademySiteConfig } from '../academy-site.config';
import { AiJobError } from '../ai/ai-job.error';
import { AI_JOB_HANDLERS, AiJobHandler } from './ai-job.handler';
import { AiJobService } from './ai-job.service';

const POLL_MS = 3_000;
const LEASE_MS = 5 * 60_000;

/**
 * In-process worker. On boot (when the feature and worker are both enabled) it
 * polls for claimable jobs and dispatches each to its registered handler, up to
 * WORKER_CONCURRENCY at once. Claiming uses FOR UPDATE SKIP LOCKED, so running
 * this on several replicas is safe. A per-job heartbeat renews the lease so a
 * long run is not stolen by another worker.
 */
@Injectable()
export class AiJobWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiJobWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = 0;
  private ticking = false;

  constructor(
    private readonly config: AcademySiteConfig,
    private readonly jobs: AiJobService,
    @Inject(AI_JOB_HANDLERS) private readonly handlers: AiJobHandler[],
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled || !this.config.workerEnabled) {
      this.logger.log('AI job worker disabled (AI_ACADEMY_ENABLED / WORKER_ENABLED)');
      return;
    }
    this.logger.log(`AI job worker started (concurrency=${this.config.workerConcurrency})`);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // avoid overlapping claim loops
    this.ticking = true;
    try {
      while (this.active < this.config.workerConcurrency) {
        const job = await this.jobs.claimNext(LEASE_MS);
        if (!job) break;
        this.active++;
        void this.process(job).finally(() => {
          this.active--;
        });
      }
    } catch (e) {
      this.logger.error(`claim loop error: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async process(job: AiJob): Promise<void> {
    const handler = this.handlers.find((h) => h.type === job.type);
    if (!handler) {
      await this.jobs.fail(job.id, {
        message: `No handler registered for job type ${job.type}`,
        errorClass: 'TERMINAL',
      });
      return;
    }
    const heartbeat = setInterval(
      () => void this.jobs.renewLease(job.id, LEASE_MS).catch(() => undefined),
      Math.floor(LEASE_MS / 2),
    );
    try {
      const result = await handler.handle(job);
      await this.jobs.succeed(job.id, result ?? {});
    } catch (e) {
      const errorClass = e instanceof AiJobError ? e.errorClass : 'RETRYABLE';
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`job ${job.id} (${job.type}) failed [${errorClass}]: ${message}`);
      await this.jobs.fail(job.id, { message, errorClass });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
