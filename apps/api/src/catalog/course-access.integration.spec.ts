import { randomUUID } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { Role } from '@darsly/shared-types';
import { databaseReady } from '../common/testing/db-available';
import { PrismaService } from '../prisma/prisma.service';
import { EntryExamService } from '../courses/entry-exam.service';
import { CoursesService } from '../courses/courses.service';
import { PlaybackService } from '../playback/playback.service';
import { NotesController } from '../playback/notes.controller';
import { UploadsController } from '../uploads/uploads.controller';
import { LessonAccessService } from '../assessments/lesson-access.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { AcademyService } from '../academy/academy.service';
import { PublicSiteService } from '../academy-site/public/public-site.service';

/**
 * The academic-year rule, end to end, on a real PostgreSQL.
 *
 * A third-secondary student opened a first-baccalaureate course from the
 * teacher's storefront and played its free preview: the year was asked only
 * by the enrolment routes, five other routes decided lesson access each in
 * their own way, and two storefront listings did not narrow by year at all.
 * Every route now asks catalog/course-access.ts. This is the matrix that
 * keeps them agreeing:
 *
 *   students  — the course's year · another year · no year on record ·
 *               another year but already ACTIVE · another year, EXPIRED
 *   surfaces  — listings · course page · free-preview video · paid video ·
 *               class notes · own notes · attachments · quizzes · enrolment
 *
 * plus the owner teacher and the super admin, who are never narrowed.
 */
const prisma = new PrismaService();
let available = true;

beforeAll(async () => {
  available = await databaseReady(prisma, ['course', 'courseGrade', 'gradeLevel', 'enrollment']);
  if (!available) return;
  await prisma.onModuleInit();
}, 30_000);
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});
const guard = () => {
  if (!available) console.warn('skipping: no database reachable at DATABASE_URL');
  return available;
};

type Kind = 'match' | 'other' | 'none' | 'heldActive' | 'heldExpired';
interface World {
  slug: string;
  academyId: string;
  teacherUserId: string;
  tenantId: string;
  adminUserId: string;
  courseId: string;
  openCourseId: string;
  previewLessonId: string;
  paidLessonId: string;
  openPreviewLessonId: string;
  previewAttachmentId: string;
  paidAttachmentId: string;
  students: Record<Kind, { userId: string; studentId: string }>;
}

async function seed(): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const bacc1 = await prisma.gradeLevel.create({
    data: { nameAr: `أولى بكالوريا ${tag}`, nameEn: 'Bacc 1', code: `qa-bacc1-${tag}` },
  });
  const sec3 = await prisma.gradeLevel.create({
    data: { nameAr: `تالتة ثانوي ${tag}`, nameEn: 'Sec 3', code: `qa-sec3-${tag}` },
  });
  const teacherUser = await prisma.user.create({
    data: { role: 'TEACHER', fullName: 'QA Teacher', email: `qa-t-${tag}@example.test` },
  });
  const teacher = await prisma.teacherProfile.create({
    data: { userId: teacherUser.id, slug: `qa-${tag}`, status: 'APPROVED' },
  });
  const slug = `qa-a-${tag}`;
  await prisma.academy.create({
    data: { id: teacher.id, slug, name: 'QA Academy', ownerUserId: teacherUser.id, feeValue: 0 },
  });
  const admin = await prisma.user.create({
    data: { role: 'SUPER_ADMIN', fullName: 'QA Admin', email: `qa-admin-${tag}@example.test` },
  });

  const mkCourse = async (title: string, gradeIds: string[]) => {
    const c = await prisma.course.create({
      data: {
        tenantId: teacher.id,
        academyId: teacher.id,
        title,
        priceCents: 1000,
        status: 'PUBLISHED',
        grades: { create: gradeIds.map((gradeId) => ({ gradeId })) },
      },
    });
    const unit = await prisma.courseUnit.create({ data: { courseId: c.id, title: 'U1' } });
    const preview = await prisma.lesson.create({
      data: { unitId: unit.id, title: 'Trial', isFreePreview: true },
    });
    const paid = await prisma.lesson.create({ data: { unitId: unit.id, title: 'Paid' } });
    return { c, preview, paid };
  };
  const scoped = await mkCourse('QA first-bacc course', [bacc1.id]);
  const open = await mkCourse('QA course for every year', []);
  const att = (lessonId: string) =>
    prisma.attachment.create({
      data: {
        lessonId,
        fileName: 'sheet.pdf',
        storageKey: `qa/${randomUUID()}`,
        mimeType: 'application/pdf',
      },
    });
  const previewAtt = await att(scoped.preview.id);
  const paidAtt = await att(scoped.paid.id);

  const mkStudent = async (gradeId: string | null, enrollment?: 'ACTIVE' | 'EXPIRED') => {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: 'QA Student', email: `qa-s-${randomUUID()}@example.test` },
    });
    const s = await prisma.studentProfile.create({ data: { userId: u.id, gradeId } });
    if (enrollment) {
      await prisma.enrollment.create({
        data: {
          studentId: s.id,
          courseId: scoped.c.id,
          tenantId: teacher.id,
          academyId: teacher.id,
          status: enrollment,
          approvedAt: new Date(Date.now() - 86_400_000),
          ...(enrollment === 'EXPIRED' ? { expiresAt: new Date(Date.now() - 3600_000) } : {}),
        },
      });
    }
    return { userId: u.id, studentId: s.id };
  };

  return {
    slug,
    academyId: teacher.id,
    teacherUserId: teacherUser.id,
    tenantId: teacher.id,
    adminUserId: admin.id,
    courseId: scoped.c.id,
    openCourseId: open.c.id,
    previewLessonId: scoped.preview.id,
    paidLessonId: scoped.paid.id,
    openPreviewLessonId: open.preview.id,
    previewAttachmentId: previewAtt.id,
    paidAttachmentId: paidAtt.id,
    students: {
      match: await mkStudent(bacc1.id),
      other: await mkStudent(sec3.id),
      none: await mkStudent(null),
      heldActive: await mkStudent(sec3.id, 'ACTIVE'),
      heldExpired: await mkStudent(sec3.id, 'EXPIRED'),
    },
  };
}

const studentPrice = {
  displayPrice: async (_t: string, p: number) => p,
  applyToMany: async <T>(items: T[]) => items,
} as any;
const entryExam = new EntryExamService(prisma);
const courses = () =>
  new CoursesService(
    prisma,
    studentPrice,
    { hiddenTeacherIds: async () => [] } as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    entryExam,
  );
const playback = () =>
  new PlaybackService(
    prisma,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    entryExam,
  );
const storage = {
  exists: async () => true,
  getStream: async () => ({ stream: Readable.from(['pdf']), contentLength: 3 }),
} as any;
const uploads = () => new UploadsController(prisma, null as any, storage, null as any);
const enrollments = () =>
  new EnrollmentsService(prisma, null as any, null as any, { isEnabled: async () => false } as any);

/** The refusal code of a rejected call, or 'OK'. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e: any) {
    const body = e?.getResponse?.();
    return (body && typeof body === 'object' && body.code) || e?.constructor?.name || 'ERROR';
  }
}

const asStudent = (userId: string) => ({ sub: userId, role: Role.STUDENT }) as any;
const download = (userId: string, role: Role, tenantId: string | undefined, id: string) => {
  const res: any = new PassThrough();
  res.setHeader = () => undefined;
  return uploads().downloadAttachment({ sub: userId, role, tenantId } as any, id, res);
};

describe('the academic-year rule, across every route that serves a course', () => {
  let w: World;
  beforeAll(async () => {
    if (!available) return;
    w = await seed();
  }, 60_000);

  // What each kind of student gets, surface by surface.
  const expected: Record<
    Kind,
    {
      listed: boolean;
      yearState: string;
      preview: string;
      paid: string;
      enrol: string;
    }
  > = {
    match: {
      listed: true,
      yearState: 'OK',
      preview: 'OK',
      paid: 'NOT_ENROLLED',
      enrol: 'PAYMENT_REQUIRED',
    },
    other: {
      listed: false,
      yearState: 'OTHER_YEAR',
      preview: 'COURSE_OTHER_YEAR',
      paid: 'COURSE_OTHER_YEAR',
      enrol: 'COURSE_OTHER_YEAR',
    },
    // Shown (a listing is not a door), but asked for their year at every door.
    none: {
      listed: true,
      yearState: 'YEAR_REQUIRED',
      preview: 'YEAR_REQUIRED',
      paid: 'YEAR_REQUIRED',
      enrol: 'YEAR_REQUIRED',
    },
    // Already theirs: moving up a year takes nothing away.
    heldActive: {
      listed: false,
      yearState: 'OK',
      preview: 'OK',
      paid: 'OK',
      enrol: 'ALREADY_ENROLLED',
    },
    // Lapsed, but held: the preview and the renewal stay open; paid lessons wait for renewal.
    heldExpired: {
      listed: false,
      yearState: 'OK',
      preview: 'OK',
      paid: 'NOT_ENROLLED',
      enrol: 'PAYMENT_REQUIRED',
    },
  };

  for (const kind of Object.keys(expected) as Kind[]) {
    describe(`a student — ${kind}`, () => {
      const want = expected[kind];
      const s = () => w.students[kind];

      it('listings: storefront, published site and discovery agree', async () => {
        if (!guard()) return;
        const store = await new AcademyService(prisma).publicCourses(w.academyId, s().userId);
        const site = await new PublicSiteService(prisma, studentPrice).courses(
          w.slug,
          50,
          s().userId,
        );
        const found = await courses().discover({ teacherId: w.tenantId } as any, s().userId);
        const ids = (found as any).items.map((c: { id: string }) => c.id);
        expect(store.some((c) => c.id === w.courseId)).toBe(want.listed);
        expect(site.some((c) => c.url === `/course/${w.courseId}`)).toBe(want.listed);
        expect(ids.includes(w.courseId)).toBe(want.listed);
        // A course that names no year is for everyone.
        expect(store.some((c) => c.id === w.openCourseId)).toBe(true);
      });

      it('course page: the year state, and padlocks that match the routes', async () => {
        if (!guard()) return;
        const d: any = await courses().publicDetail(w.courseId, asStudent(s().userId));
        expect(d.viewer.yearState).toBe(want.yearState);
        expect(d.viewer.forMyYear).toBe(want.yearState === 'OK');
        const lessons = d.units.flatMap((u: any) => u.lessons);
        const preview = lessons.find((l: any) => l.id === w.previewLessonId);
        const paid = lessons.find((l: any) => l.id === w.paidLessonId);
        expect(preview.locked).toBe(want.preview !== 'OK');
        expect(paid.locked).toBe(want.paid !== 'OK');
        // Attachments are only listed on a lesson that is open.
        expect(preview.attachments.length > 0).toBe(want.preview === 'OK');
      });

      it('free-preview video and its class notes', async () => {
        if (!guard()) return;
        const pb = playback() as any;
        expect(
          await outcome(pb.lessonEntitlement(s().userId, Role.STUDENT, w.previewLessonId)),
        ).toBe(want.preview);
        expect(await outcome(pb.lessonClassNotes(asStudent(s().userId), w.previewLessonId))).toBe(
          want.preview,
        );
      });

      it('paid video', async () => {
        if (!guard()) return;
        const pb = playback() as any;
        expect(await outcome(pb.lessonEntitlement(s().userId, Role.STUDENT, w.paidLessonId))).toBe(
          want.paid,
        );
      });

      it("the student's own notes", async () => {
        if (!guard()) return;
        const notes = new NotesController(prisma);
        expect(
          await outcome(
            notes.create(asStudent(s().userId), w.previewLessonId, { timestampSec: 1, body: 'n' }),
          ),
        ).toBe(want.preview);
      });

      it('attachments (refused as not found, so ids cannot be probed)', async () => {
        if (!guard()) return;
        const prev = await outcome(
          download(s().userId, Role.STUDENT, undefined, w.previewAttachmentId),
        );
        const paid = await outcome(
          download(s().userId, Role.STUDENT, undefined, w.paidAttachmentId),
        );
        expect(prev).toBe(want.preview === 'OK' ? 'OK' : 'NotFoundException');
        expect(paid).toBe(want.paid === 'OK' ? 'OK' : 'NotFoundException');
      });

      it('lesson quizzes and assignments', async () => {
        if (!guard()) return;
        const access = new LessonAccessService(prisma, entryExam);
        expect(await outcome(access.requireStudentAccess(s().userId, w.previewLessonId))).toBe(
          want.preview,
        );
        expect(await outcome(access.requireStudentAccess(s().userId, w.paidLessonId))).toBe(
          want.paid,
        );
      });

      it('enrolment', async () => {
        if (!guard()) return;
        expect(await outcome(enrollments().enroll(s().userId, w.courseId))).toBe(want.enrol);
      });
    });
  }

  it('a course that names no year is open to a student with no year', async () => {
    if (!guard()) return;
    const pb = playback() as any;
    expect(
      await outcome(
        pb.lessonEntitlement(w.students.none.userId, Role.STUDENT, w.openPreviewLessonId),
      ),
    ).toBe('OK');
  });

  it('the owner teacher and the super admin are never narrowed', async () => {
    if (!guard()) return;
    const pb = playback() as any;
    for (const lesson of [w.previewLessonId, w.paidLessonId]) {
      expect(await outcome(pb.lessonEntitlement(w.teacherUserId, Role.TEACHER, lesson))).toBe('OK');
      expect(await outcome(pb.lessonEntitlement(w.adminUserId, Role.SUPER_ADMIN, lesson))).toBe(
        'OK',
      );
    }
    expect(
      await outcome(download(w.teacherUserId, Role.TEACHER, w.tenantId, w.paidAttachmentId)),
    ).toBe('OK');
    expect(
      await outcome(download(w.adminUserId, Role.SUPER_ADMIN, undefined, w.paidAttachmentId)),
    ).toBe('OK');
    const d: any = await courses().publicDetail(w.courseId, {
      sub: w.teacherUserId,
      role: Role.TEACHER,
      tenantId: w.tenantId,
    } as any);
    expect(d.viewer.yearState).toBe('OK');
  });

  it('a visitor sees the whole storefront (nothing to narrow to)', async () => {
    if (!guard()) return;
    const store = await new AcademyService(prisma).publicCourses(w.academyId);
    expect(store.some((c) => c.id === w.courseId)).toBe(true);
  });
});
