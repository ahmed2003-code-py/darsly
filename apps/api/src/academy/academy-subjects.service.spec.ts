import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AcademySubjectsService } from './academy-subjects.service';

function makePrisma(kind: 'PERSONAL' | 'CENTER') {
  return {
    academy: { findUniqueOrThrow: jest.fn().mockResolvedValue({ kind }) },
    subject: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'maths',
          code: 'MATH',
          nameAr: 'رياضيات',
          nameEn: 'Maths',
          icon: null,
          track: 'BOTH',
        },
        { id: 'phys', code: 'PHY', nameAr: 'فيزياء', nameEn: 'Physics', icon: null, track: 'BOTH' },
      ]),
      findFirst: jest.fn().mockResolvedValue({ id: 'maths' }),
      create: jest.fn(),
    },
    academySubject: {
      findMany: jest.fn().mockResolvedValue([{ subjectId: 'maths', isActive: true }]),
      upsert: jest.fn(async ({ create, update }: any) => ({
        subjectId: create.subjectId,
        isActive: update.isActive,
      })),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  } as any;
}

describe('AcademySubjectsService', () => {
  it('CENTER: opt-in — only rows switched on read as offered', async () => {
    const res = await new AcademySubjectsService(makePrisma('CENTER')).list('centerA');
    expect(res.gated).toBe(true);
    expect(res.subjects.map((s) => [s.id, s.offered])).toEqual([
      ['maths', true],
      ['phys', false],
    ]);
  });

  it('PERSONAL: never gated — everything offered, activation rows ignored', async () => {
    const res = await new AcademySubjectsService(makePrisma('PERSONAL')).list('teacherT');
    expect(res.gated).toBe(false);
    expect(res.subjects.every((s) => s.offered)).toBe(true);
  });

  it('activating upserts one (academyId, subjectId) row and never creates a Subject', async () => {
    const prisma = makePrisma('CENTER');
    await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', true);
    expect(prisma.academySubject.upsert.mock.calls[0][0].where).toEqual({
      academyId_subjectId: { academyId: 'centerA', subjectId: 'maths' },
    });
    expect(prisma.subject.create).not.toHaveBeenCalled();
  });

  it('deactivating keeps the row (soft) and leaves the master Subject alone', async () => {
    const prisma = makePrisma('CENTER');
    const row = await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', false);
    expect(row.isActive).toBe(false);
    expect(prisma.academySubject.upsert.mock.calls[0][0].update).toEqual({ isActive: false });
  });

  it('a PERSONAL workspace cannot activate subjects', async () => {
    await expect(
      new AcademySubjectsService(makePrisma('PERSONAL')).setOffered('t', 'maths', true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unknown / inactive master subject cannot be activated', async () => {
    const prisma = makePrisma('CENTER');
    prisma.subject.findFirst.mockResolvedValue(null);
    await expect(
      new AcademySubjectsService(prisma).setOffered('centerA', 'ghost', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.academySubject.upsert).not.toHaveBeenCalled();
  });

  it("scope is always the caller's academyId — Center A can only ever write Center A rows", async () => {
    const prisma = makePrisma('CENTER');
    await new AcademySubjectsService(prisma).setOffered('centerA', 'maths', true);
    expect(prisma.academySubject.upsert.mock.calls[0][0].create.academyId).toBe('centerA');
  });
});

/**
 * The core set is not a choice a Center makes. It is opted in on read —
 * `skipDuplicates`, so an owner who switched one off keeps it off.
 */
describe('AcademySubjectsService — core subjects', () => {
  function corePrisma(rows: { subjectId: string; isActive: boolean }[]) {
    const p = {
      academy: { findUniqueOrThrow: jest.fn().mockResolvedValue({ kind: 'CENTER' }) },
      subject: {
        findMany: jest.fn(async ({ where }: any) =>
          where?.isCore
            ? [{ id: 'arabic' }]
            : [
                {
                  id: 'arabic',
                  code: 'arabic',
                  nameAr: 'عربي',
                  nameEn: 'Arabic',
                  icon: null,
                  track: 'BOTH',
                  isCore: true,
                },
                {
                  id: 'phys',
                  code: 'PHY',
                  nameAr: 'فيزياء',
                  nameEn: 'Physics',
                  icon: null,
                  track: 'BOTH',
                  isCore: false,
                },
              ],
        ),
      },
      academySubject: {
        findMany: jest.fn().mockResolvedValue(rows),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    } as any;
    return p;
  }

  it('a Center with no rows at all is opted into the core set', async () => {
    const prisma = corePrisma([]);
    await new AcademySubjectsService(prisma).list('centerA');
    expect(prisma.academySubject.createMany).toHaveBeenCalledWith({
      data: [{ academyId: 'centerA', subjectId: 'arabic', isActive: true }],
      skipDuplicates: true,
    });
  });

  it('a core subject the owner switched off is not switched back on', async () => {
    // skipDuplicates is what guarantees this: the row already exists.
    const prisma = corePrisma([{ subjectId: 'arabic', isActive: false }]);
    const res = await new AcademySubjectsService(prisma).list('centerA');
    expect(res.subjects.find((s) => s.id === 'arabic')?.offered).toBe(false);
    expect(prisma.academySubject.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('a PERSONAL workspace is never opted into anything', async () => {
    const prisma = corePrisma([]);
    prisma.academy.findUniqueOrThrow.mockResolvedValue({ kind: 'PERSONAL' });
    await new AcademySubjectsService(prisma).list('teacherT');
    expect(prisma.academySubject.createMany).not.toHaveBeenCalled();
  });

  it('activate-all writes the missing rows and flips every existing one', async () => {
    const prisma = corePrisma([]);
    const res = await new AcademySubjectsService(prisma).setAllOffered('centerA', true);
    expect(res).toEqual({ count: 2, isActive: true });
    expect(prisma.academySubject.updateMany).toHaveBeenCalledWith({
      where: { academyId: 'centerA' },
      data: { isActive: true },
    });
  });

  it('a PERSONAL workspace cannot activate-all', async () => {
    const prisma = corePrisma([]);
    prisma.academy.findUniqueOrThrow.mockResolvedValue({ kind: 'PERSONAL' });
    await expect(
      new AcademySubjectsService(prisma).setAllOffered('teacherT', true),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
