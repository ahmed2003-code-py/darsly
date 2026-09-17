import { AcademyMediaService } from '../academy-site/media/academy-media.service';
import { SubjectExclusivityService } from '../catalog/subject-exclusivity.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentPriceService } from '../payments/student-price.service';
import { StorageProvider } from '../storage/storage.provider';
import { VideoProcessingService } from '../video/video-processing.service';
import { YoutubeImportService } from '../video/youtube-import.service';
import { LessonDescriptionService } from '../video/lesson-description.service';
import { CoursesService } from './courses.service';

/**
 * A course's years, in the one shape every screen reads.
 *
 * Prisma hands back the join rows — `{ courseId, gradeId, grade }` — and the
 * teacher's own list used to pass them straight through. Every screen reads
 * `grade.id` and `grade.nameAr` off that list, so the years came back named
 * `undefined`; and because the edit form seeds itself from the same list,
 * reopening a course and changing its price sent `gradeIds: [undefined]` and
 * the save was refused with "each value in gradeIds must be a string" — a true
 * sentence about a value the teacher never typed.
 */
const none = {} as any;
const svc = (prisma: any) =>
  new CoursesService(
    prisma as PrismaService,
    { applyToMany: async (i: unknown[]) => i } as unknown as StudentPriceService,
    { hiddenTeacherIds: async () => [] } as unknown as SubjectExclusivityService,
    none as StorageProvider,
    none as VideoProcessingService,
    none as YoutubeImportService,
    none as LessonDescriptionService,
    none as AcademyMediaService,
    none,
  );

const JOIN_ROWS = [
  { courseId: 'c1', gradeId: 'g1', grade: { id: 'g1', nameAr: 'الأول الثانوي', nameEn: 'Grade 10' } },
  { courseId: 'c1', gradeId: 'g2', grade: { id: 'g2', nameAr: 'الثاني الثانوي', nameEn: 'Grade 11' } },
];

describe("a teacher's own course list", () => {
  it('hands back the years themselves, not the rows that join them', async () => {
    const prisma = { course: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', grades: JOIN_ROWS }]) } };
    const [course] = await svc(prisma).listMine('t1');
    expect(course.grades).toEqual([
      { id: 'g1', nameAr: 'الأول الثانوي', nameEn: 'Grade 10' },
      { id: 'g2', nameAr: 'الثاني الثانوي', nameEn: 'Grade 11' },
    ]);
  });

  it('gives the edit form ids it can send straight back', async () => {
    const prisma = { course: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', grades: JOIN_ROWS }]) } };
    const [course] = await svc(prisma).listMine('t1');
    const gradeIds = ((course.grades ?? []) as { id: string }[]).map((g) => g.id);
    expect(gradeIds).toEqual(['g1', 'g2']);
    expect(gradeIds.every((id: unknown) => typeof id === 'string')).toBe(true);
  });

  it('does the same for one course opened on its own', async () => {
    const prisma = { course: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', grades: JOIN_ROWS }) } };
    const course = await svc(prisma).getMine('t1', 'c1');
    expect((course.grades as { id: string }[]).map((g) => g.id)).toEqual(['g1', 'g2']);
  });

  it('leaves a course with no years alone', async () => {
    const prisma = { course: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', grades: [] }]) } };
    const [course] = await svc(prisma).listMine('t1');
    expect(course.grades).toEqual([]);
  });
});

/**
 * Editing a course you already own.
 *
 * The edit form restates every field it loaded, so a teacher changing nothing
 * but the price still sends the course's existing subject. Running that through
 * the "did you sign up to teach this?" gate locked a teacher out of their own
 * course whenever their subject list had moved underneath them — an admin
 * edited it, or the catalogue changed — and refused the save with a sentence
 * about a subject they had not touched.
 */
describe('changing the price of a course whose subject is no longer yours', () => {
  const prismaFor = (courseSubject: string | null, teacherSubjects: string[]) => ({
    course: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', tenantId: 't1' }),
      findUnique: jest.fn().mockResolvedValue({
        subjectId: courseSubject,
        examLessonId: null,
        grades: [{ gradeId: 'g1' }, { gradeId: 'g2' }],
      }),
      update: jest.fn(async (args: any) => ({ id: 'c1', ...args.data, grades: [] })),
    },
    teacherProfile: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        stages: ['SECONDARY'],
        subjects: teacherSubjects.map((subjectId) => ({ subjectId })),
      }),
    },
    // Reached only when the subject really is being moved: a course left where
    // it is never gets this far, which is the whole point of the change.
    gradeLevel: { findMany: jest.fn().mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]) },
  });

  it('goes through when the subject is simply left where it was', async () => {
    // The teacher teaches Arabic; the course sits on Maths and always has.
    const prisma = prismaFor('maths', ['arabic']);
    const out = await svc(prisma).update('t1', 'c1', { subjectId: 'maths', priceCents: 0 } as any);
    expect(out).toBeTruthy();
    expect(prisma.course.update).toHaveBeenCalled();
    // Nothing was re-aimed: the subject is not rewritten on the way through.
    expect(prisma.course.update.mock.calls[0][0].data.subjectId).toBeUndefined();
  });

  it('lets that same edit make the course free', async () => {
    const prisma = prismaFor('maths', ['arabic']);
    await svc(prisma).update('t1', 'c1', { subjectId: 'maths', priceCents: 0 } as any);
    expect(prisma.course.update.mock.calls[0][0].data.priceCents).toBe(0);
  });

  it('still refuses a move to a subject that is not theirs', async () => {
    const prisma = prismaFor('maths', ['arabic']);
    await expect(svc(prisma).update('t1', 'c1', { subjectId: 'physics' } as any)).rejects.toThrow();
  });

  it('still allows a move to one that is', async () => {
    const prisma = prismaFor('maths', ['arabic']);
    const out = await svc(prisma).update('t1', 'c1', { subjectId: 'arabic' } as any);
    expect(out).toBeTruthy();
  });
});

describe('changing the price of a course aimed at years you no longer teach', () => {
  const prismaFor = (teacherStages: string[]) => ({
    course: {
      findFirst: jest.fn().mockResolvedValue({ id: 'c1', tenantId: 't1' }),
      findUnique: jest.fn().mockResolvedValue({
        subjectId: 'maths',
        examLessonId: null,
        grades: [{ gradeId: 'g1' }, { gradeId: 'g2' }],
      }),
      update: jest.fn(async (args: any) => ({ id: 'c1', ...args.data, grades: [] })),
    },
    teacherProfile: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ stages: teacherStages, subjects: [{ subjectId: 'maths' }] }),
    },
    gradeLevel: { findMany: jest.fn().mockResolvedValue([{ id: 'g9' }]) },
  });

  it('goes through when the years are exactly the ones already on it', async () => {
    // The teacher now teaches only SECONDARY; the course has always been aimed
    // at two primary years. Restating them is not a change.
    const prisma = prismaFor(['SECONDARY']);
    await svc(prisma).update('t1', 'c1', { gradeIds: ['g1', 'g2'], priceCents: 0 } as any);
    expect(prisma.course.update.mock.calls[0][0].data.priceCents).toBe(0);
    expect(prisma.course.update.mock.calls[0][0].data.grades).toBeUndefined();
  });

  it('does not care what order the boxes were ticked in', async () => {
    const prisma = prismaFor(['SECONDARY']);
    await svc(prisma).update('t1', 'c1', { gradeIds: ['g2', 'g1'], priceCents: 500 } as any);
    expect(prisma.course.update.mock.calls[0][0].data.grades).toBeUndefined();
  });

  it('still refuses a move to a year the teacher does not teach', async () => {
    const prisma = prismaFor(['SECONDARY']);
    await expect(svc(prisma).update('t1', 'c1', { gradeIds: ['g1', 'g3'] } as any)).rejects.toThrow();
  });
});
