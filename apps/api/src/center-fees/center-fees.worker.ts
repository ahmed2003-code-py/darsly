import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeePlansService } from './fee-plans.service';

const SWEEP_MS = 30 * 60_000;

/**
 * Posts what fee plans have due now — this month's fee on its anchor day,
 * each class attended — for academies with centerFees on. Reading the fees
 * screens tops an academy up too, so this is the background half. Posting is
 * idempotent (unique indexes), so two replicas sweeping at once only cost a
 * little work. Off under tests (NODE_ENV=test) and with CENTER_FEES_WORKER=off.
 */
@Injectable()
export class CenterFeesWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CenterFeesWorker.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: FeePlansService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.CENTER_FEES_WORKER === 'off') return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    setTimeout(() => void this.sweep(), 90_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let posted = 0;
    try {
      const academies = await this.prisma.academyFeatureFlag.findMany({
        where: { key: 'centerFees', enabled: true },
        select: { academyId: true },
      });
      for (const { academyId } of academies) {
        try {
          posted += await this.plans.generateAcademy(academyId);
        } catch (e) {
          this.logger.error(`fee generation failed academy=${academyId}: ${(e as Error).message}`);
        }
      }
      if (posted) this.logger.log(`posted ${posted} center fee charge(s)`);
    } finally {
      this.running = false;
    }
    return posted;
  }
}
