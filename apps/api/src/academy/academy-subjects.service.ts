import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Which platform subjects a Center offers. The master Subject catalogue is
 * platform-owned and never touched here — a Center only switches an existing
 * row on or off for itself. Opt-in: a missing AcademySubject row means "not
 * offered", except for the core subjects, which a Center is opted into the
 * moment it exists (see `ensureCore`). A PERSONAL workspace is never gated
 * (its teacher's own TeacherSubject list is the reach there), so every subject
 * reads as offered.
 */
@Injectable()
export class AcademySubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opt this Center into the core subjects, once.
   *
   * The migration does this for every Center that existed when it ran; this is
   * the same thing for every Center created after, and for a core subject the
   * platform adds later. `skipDuplicates` is what makes it safe to call on
   * every read: a Center that has deliberately switched Arabic *off* already
   * has a row, so nothing here switches it back on.
   */
  private async ensureCore(academyId: string): Promise<void> {
    const core = await this.prisma.subject.findMany({ where: { isCore: true, isActive: true }, select: { id: true } });
    if (!core.length) return;
    await this.prisma.academySubject.createMany({
      data: core.map((s) => ({ academyId, subjectId: s.id, isActive: true })),
      skipDuplicates: true,
    });
  }

  async list(academyId: string) {
    const academy = await this.prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { kind: true } });
    if (academy.kind === 'CENTER') await this.ensureCore(academyId);

    const [subjects, rows] = await Promise.all([
      this.prisma.subject.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
        select: { id: true, code: true, nameAr: true, nameEn: true, icon: true, track: true, isCore: true },
      }),
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

  /**
   * The same answer for the whole catalogue at once.
   *
   * A desk that offers everything, or that is starting over, was otherwise
   * making one round trip per subject — forty of them, each re-rendering the
   * list. One statement instead, and one audit line.
   */
  async setAllOffered(academyId: string, isActive: boolean) {
    const academy = await this.prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { kind: true } });
    if (academy.kind !== 'CENTER') {
      throw new BadRequestException({ message: 'Only a Center activates subjects', code: 'NOT_A_CENTER' });
    }
    const subjects = await this.prisma.subject.findMany({ where: { isActive: true }, select: { id: true } });
    await this.prisma.$transaction([
      this.prisma.academySubject.createMany({
        data: subjects.map((s) => ({ academyId, subjectId: s.id, isActive })),
        skipDuplicates: true,
      }),
      this.prisma.academySubject.updateMany({ where: { academyId }, data: { isActive } }),
    ]);
    return { count: subjects.length, isActive };
  }
}
