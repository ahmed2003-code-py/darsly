import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AcademySubjectsService } from './academy-subjects.service';

function makePrisma(kind: 'PERSONAL' | 'CENTER') {
  return {
    academy: { findUniqueOrThrow: jest.fn().mockResolvedValue({ kind }) },
    subject: {
      findMany: jest.fn().mockResolvedValue([{ id: 'maths', code: 'MATH', nameAr: 'رياضيات', nameEn: 'Maths', icon: null, track: 'BOTH' }, { id: 'phys', code: 'PHY', nameAr: 'فيزياء', nameEn: 'Physics', icon: null, track: 'BOTH' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'maths' }),
      create: jest.fn(),
    },
    academySubject: {
      findMany: jest.fn().mockResolvedValue([{ subjectId: 'maths', isActive: true }]),
      upsert: jest.fn(async ({ create, update }: any) => ({ subjectId: create.subjectId, isActive: update.isActive })),
    },
  } as any;
}

describe('AcademySubjectsService', () => {
  it('CENTER: opt-in — only rows switched on read as offered', async () => {
    const res = await new AcademySubjectsService(makePrisma('CENTER')).list('centerA');
    expect(res.gated).toBe(true);
    expect(res.subjects.map((s) => [s.id, s.offered])).toEqual([['maths', true], ['phys', false]]);
  });

  it('PERSONAL: never gated — everything offered, activation rows ignored', async () => {
    const res = await new AcademySubjectsService(makePrisma('PERSONAL')).list('teacherT');
    expect(res.gated).toBe(false);
    expect(res.subjects.every((s) => s.offered)).toBe(true);
  });

  it('activating upserts one (academyId, subjectId) row and never creates a Subject', async () => {
    const prisma = makePrisma('CENTER');
    await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', true);
    expect(prisma.academySubject.upsert.mock.calls[0][0].where).toEqual({ academyId_subjectId: { academyId: 'centerA', subjectId: 'maths' } });
    expect(prisma.subject.create).not.toHaveBeenCalled();
  });

  it('deactivating keeps the row (soft) and leaves the master Subject alone', async () => {
    const prisma = makePrisma('CENTER');
    const row = await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', false);
    expect(row.isActive).toBe(false);
    expect(prisma.academySubject.upsert.mock.calls[0][0].update).toEqual({ isActive: false });
  });

  it('a PERSONAL workspace cannot activate subjects', async () => {
    await expect(new AcademySubjectsService(makePrisma('PERSONAL')).setOffered('t', 'maths', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unknown / inactive master subject cannot be activated', async () => {
    const prisma = makePrisma('CENTER');
    prisma.subject.findFirst.mockResolvedValue(null);
    await expect(new AcademySubjectsService(prisma).setOffered('centerA', 'ghost', true)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.academySubject.upsert).not.toHaveBeenCalled();
  });

  it('scope is always the caller\'s academyId — Center A can only ever write Center A rows', async () => {
    const prisma = makePrisma('CENTER');
    await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', true);
    expect(prisma.academySubject.upsert.mock.calls[0][0].create.academyId).toBe('centerA');
  });
});
