import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PaymentMethod } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { SenderRuleLike } from './sms-parser';

/**
 * Serves the backend-driven sender classification rules to devices and seeds a
 * sensible default set on first boot (so classification works out of the box and
 * is still fully editable from the DB — logic is never hard-coded in the APK).
 */
@Injectable()
export class SenderRulesService implements OnModuleInit {
  private readonly logger = new Logger(SenderRulesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Egyptian financial senders. Sender ids rarely equal the brand exactly, so we
  // match on CONTAINS against a normalized (lowercased) sender id.
  private static readonly DEFAULTS: Array<Omit<SenderRuleLike, 'enabled'> & { enabled: boolean }> = [
    { brand: 'CIB', matchType: 'CONTAINS', pattern: 'cib', provider: PaymentMethod.BANK_TRANSFER, enabled: true, forwardToBackend: true, priority: 10 },
    { brand: 'Vodafone Cash', matchType: 'CONTAINS', pattern: 'vodafone', provider: PaymentMethod.VODAFONE_CASH, enabled: true, forwardToBackend: true, priority: 20 },
    { brand: 'Vodafone Cash', matchType: 'CONTAINS', pattern: 'vfcash', provider: PaymentMethod.VODAFONE_CASH, enabled: true, forwardToBackend: true, priority: 21 },
    { brand: 'InstaPay', matchType: 'CONTAINS', pattern: 'instapay', provider: PaymentMethod.INSTAPAY, enabled: true, forwardToBackend: true, priority: 30 },
  ];

  async onModuleInit(): Promise<void> {
    const count = await this.prisma.senderRule.count();
    if (count > 0) return;
    await this.prisma.senderRule.createMany({ data: SenderRulesService.DEFAULTS as any });
    this.logger.log(`Seeded ${SenderRulesService.DEFAULTS.length} default sender rules`);
  }

  /** Enabled rules the device should apply, priority-ordered (lower wins). */
  async listEnabled(): Promise<SenderRuleLike[]> {
    const rules = await this.prisma.senderRule.findMany({
      where: { enabled: true },
      orderBy: { priority: 'asc' },
    });
    return rules.map((r) => ({
      brand: r.brand,
      matchType: r.matchType as SenderRuleLike['matchType'],
      pattern: r.pattern,
      provider: r.provider as unknown as PaymentMethod,
      enabled: r.enabled,
      forwardToBackend: r.forwardToBackend,
      priority: r.priority,
    }));
  }
}
