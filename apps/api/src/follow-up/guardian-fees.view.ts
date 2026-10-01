import { Injectable } from '@nestjs/common';
import { CenterFeesService } from '../center-fees/center-fees.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { FollowUpSettingsService } from './settings.service';

/**
 * What a guardian may see of a child's center fees (C5, Gate 1): nothing,
 * unless the academy has follow-up on AND chose to show guardians fees
 * (AcademyFollowUpSettings.guardianFeesVisible, default OFF). Independent of
 * whether the center uses fees internally.
 *
 * When shown: what is owed, what of it is overdue, and receipts (number,
 * date, amount, method, reversed). Never notes, reasons, adjustments, who
 * collected, the center's totals or another learner — CenterFeesService.
 * guardianView only returns those fields.
 *
 * The caller has already resolved an ACTIVE guardian link for exactly this
 * child and academy; this only answers for that pair.
 */
@Injectable()
export class GuardianFeesView {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly settings: FollowUpSettingsService,
    private readonly fees: CenterFeesService,
  ) {}

  async forChild(academyId: string, studentProfileId: string) {
    if (!(await this.flags.isEnabled(academyId, 'studentFollowUp'))) return null;
    if (!(await this.settings.get(academyId)).guardianFeesVisible) return null;
    const rec = await this.prisma.academyStudent.findUnique({
      where: { academyId_studentId: { academyId, studentId: studentProfileId } },
      select: { id: true },
    });
    if (!rec) return null;
    return this.fees.guardianView(academyId, rec.id);
  }
}
