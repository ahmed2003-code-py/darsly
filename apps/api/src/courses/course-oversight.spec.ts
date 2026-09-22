import { ForbiddenException } from '@nestjs/common';
import { CoursesService, CourseScope } from './courses.service';

/**
 * Oversight is not authorship.
 *
 * A Center's OWNER — and the platform admin, who is handed the same OWNER
 * context — can see every course offered under them. What they may do to one
 * they did not write is exactly one thing: take it off sale. Anything that
 * changes the content, the price or the reach belongs to the teacher whose
 * name is on it.
 */
const none = {} as any;

function makePrisma(course: { id: string; tenantId: string }) {
  return {
    academy: { findUnique: jest.fn().mockResolvedValue({ id: 'centerA', kind: 'CENTER' }) },
    academySubject: { findUnique: jest.fn().mockResolvedValue({ isActive: true }) },
    course: {
      findFirst: jest.fn().mockResolvedValue({ ...course, academyId: 'centerA', priceCents: 0, status: 'PUBLISHED' }),
      findUnique: jest.fn().mockResolvedValue({ subjectId: 'maths', examLessonId: null, grades: [] }),
      update: jest.fn(async ({ data }: any) => ({ id: course.id, ...data, grades: [] })),
      delete: jest.fn(),
    },
    courseUnit: { findFirst: jest.fn().mockResolvedValue({ id: 'u1', course: { ...course, academyId: 'centerA' } }) },
    lesson: { count: jest.fn().mockResolvedValue(1) },
    enrollment: { count: jest.fn().mockResolvedValue(0) },
  } as any;
}
const svc = (prisma: any) =>
  new CoursesService(prisma, { applyToMany: async (i: unknown[]) => i } as any, { hiddenTeacherIds: async () => [] } as any, none, none, none, none, none, none);

const theAuthor: CourseScope = { academyId: 'centerA', authorTenantId: 'teacherT', manageAll: false };
const centerOwner: CourseScope = { academyId: 'centerA', authorTenantId: 'teacherX', manageAll: true };
const platformAdmin: CourseScope = { academyId: 'centerA', authorTenantId: undefined, manageAll: true };
const someoneElses = { id: 'c1', tenantId: 'teacherT' };

describe('a course an overseer did not write', () => {
  it.each([['the Center owner', centerOwner], ['the platform admin', platformAdmin]])('%s may unpublish it', async (_label, scope) => {
    const prisma = makePrisma(someoneElses);
    const updated = await svc(prisma).update(scope, 'c1', { status: 'DRAFT' } as any);
    expect(updated.status).toBe('DRAFT');
  });

  it.each([['the Center owner', centerOwner], ['the platform admin', platformAdmin]])('%s may not retitle it', async (_label, scope) => {
    const prisma = makePrisma(someoneElses);
    await expect(svc(prisma).update(scope, 'c1', { title: 'mine now' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('a status change smuggled in beside a content change is refused whole', async () => {
    const prisma = makePrisma(someoneElses);
    await expect(svc(prisma).update(centerOwner, 'c1', { status: 'DRAFT', priceCents: 1 } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('an overseer may not delete it', async () => {
    const prisma = makePrisma(someoneElses);
    await expect(svc(prisma).remove(centerOwner, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.course.delete).not.toHaveBeenCalled();
  });

  it('an overseer may not add a unit to it', async () => {
    const prisma = makePrisma(someoneElses);
    await expect(svc(prisma).createUnit(centerOwner, 'c1', { title: 'u' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the teacher who wrote it still edits it freely', async () => {
    const prisma = makePrisma(someoneElses);
    const updated = await svc(prisma).update(theAuthor, 'c1', { title: 'v2' } as any);
    expect(updated.title).toBe('v2');
  });
});
