import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClassScheduleService } from './class-schedule.service';

const SWEEP_MS = 30 * 60_000;

/**
 * Keeps every timetable's classes generated a rolling four weeks ahead
 * (no @nestjs/schedule dependency — the same pattern as the media worker).
 * Reading Today tops an academy up as well, so this is the background half:
 * a group nobody opens still has next month's classes. Generation is
 * idempotent and serialised per slot, so two replicas sweeping at once only
 * cost a little work. Off under tests (NODE_ENV=test) and with
 * CLASS_OPS_WORKER=off.
 */
@Injectable()
export class ClassOpsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClassOpsWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ClassScheduleService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.CLASS_OPS_WORKER === 'off') return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    // First sweep shortly after boot, off the startup path.
    setTimeout(() => void this.sweep(), 60_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let created = 0;
    try {
      const academies = await this.prisma.academyFeatureFlag.findMany({
        where: { key: 'classOperations', enabled: true },
        select: { academyId: true },
      });
      for (const { academyId } of academies)
        created += await this.schedule.ensureHorizon(academyId);
      if (created) this.logger.log(`class sweep: ${created} class(es) generated`);
    } catch (e) {
      this.logger.error(`class sweep error: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return created;
  }
}
