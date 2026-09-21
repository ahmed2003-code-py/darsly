import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Which platform subjects a Center offers. The master Subject catalogue is
 * platform-owned and never touched here — a Center only switches an existing
 * row on or off for itself. Opt-in: a missing AcademySubject row means "not
 * offered". A PERSONAL workspace is never gated (its teacher's own
 * TeacherSubject list is the reach there), so every subject reads as offered.
 */
@Injectable()
export class AcademySubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(academyId: string) {
    const [academy, subjects, rows] = await Promise.all([
      this.prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { kind: true } }),
      this.prisma.subject.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }], select: { id: true, code: true, nameAr: true, nameEn: true, icon: true, track: true } }),
      this.prisma.academySubject.findMany({ where: { academyId }, select: { subjectId: true, isActive: true } }),
    ]);
    const active = new Map(rows.map((r) => [r.subjectId, r.isActive]));
    return {
      gated: academy.kind === 'CENTER',
      subjects: subjects.map((s) => ({ ...s, offered: academy.kind === 'CENTER' ? active.get(s.id) === true : true })),
    };
  }

  /** Switch one existing platform subject on/off for this academy — never creates a Subject. */
  async setOffered(academyId: string, subjectId: string, isActive: boolean) {
    const [academy, subject] = await Promise.all([
      this.prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { kind: true } }),
      this.prisma.subject.findFirst({ where: { id: subjectId, isActive: true }, select: { id: true } }),
    ]);
    if (academy.kind !== 'CENTER') {
      throw new BadRequestException({ message: 'Only a Center activates subjects', code: 'NOT_A_CENTER' });
    }
    if (!subject) throw new NotFoundException('Subject not found');
    const row = await this.prisma.academySubject.upsert({
      where: { academyId_subjectId: { academyId, subjectId } },
      update: { isActive },
      create: { academyId, subjectId, isActive },
      select: { subjectId: true, isActive: true },
    });
    return row;
  }
}
