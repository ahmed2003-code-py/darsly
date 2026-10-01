import { Injectable } from '@nestjs/common';
import { AcademyContext } from '../academy/academy-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsDto } from './dto';

export const FOLLOW_UP_DEFAULTS = {
  absenceStreak: 3,
  lateStreak: 3,
  overdueDays: 7,
  guardianFeesVisible: false,
};
export type FollowUpSettings = typeof FOLLOW_UP_DEFAULTS;

/**
 * C5's few knobs, per academy: when a streak or an overdue charge becomes a
 * signal, and whether guardians see fees. Deliberately not a rules engine.
 * The bounds are enforced twice (DTO and a database CHECK). Changing a
 * threshold changes what is derived from now on — attendance, fees, contacts
 * and existing cases are never touched.
 */
@Injectable()
export class FollowUpSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(academyId: string): Promise<FollowUpSettings> {
    const row = await this.prisma.academyFollowUpSettings.findUnique({ where: { academyId } });
    return row
      ? {
          absenceStreak: row.absenceStreak,
          lateStreak: row.lateStreak,
          overdueDays: row.overdueDays,
          guardianFeesVisible: row.guardianFeesVisible,
        }
      : { ...FOLLOW_UP_DEFAULTS };
  }

  async update(ctx: AcademyContext, dto: SettingsDto) {
    const before = await this.get(ctx.academyId);
    const data = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as Partial<FollowUpSettings>;
    await this.prisma.academyFollowUpSettings.upsert({
      where: { academyId: ctx.academyId },
      create: { academyId: ctx.academyId, ...before, ...data, updatedBy: ctx.userId },
      update: { ...data, updatedBy: ctx.userId },
    });
    const after = await this.get(ctx.academyId);
    await this.audit.log({
      actorUserId: ctx.userId,
      action: 'followup.settings.update',
      entity: 'AcademyFollowUpSettings',
      entityId: ctx.academyId,
      academyId: ctx.academyId,
      meta: { before, after },
    });
    return after;
  }
}
