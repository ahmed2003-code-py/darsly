/**
 * Darsly seed: super admin, 2 approved teachers (with courses/units/lessons),
 * 5 students (some enrolled), platform taxonomy (subjects + Egyptian grades).
 * Idempotent: safe to run repeatedly (upserts by natural keys).
 *
 * Dev credentials (also printed at the end):
 *   super admin  admin@darsly.app / Admin@12345
 *   teacher 1    khaled@darsly.app / Teacher@12345
 *   teacher 2    noura@darsly.app  / Teacher@12345
 *   students     phone login via OTP (dev universal code 0000)
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  // ── Taxonomy ──────────────────────────────────────────────────────────
  const subjectDefs = [
    { nameAr: 'الرياضيات', nameEn: 'Mathematics', icon: 'calculate', sortOrder: 1 },
    { nameAr: 'الفيزياء', nameEn: 'Physics', icon: 'science', sortOrder: 2 },
    { nameAr: 'الكيمياء', nameEn: 'Chemistry', icon: 'experiment', sortOrder: 3 },
    { nameAr: 'اللغة الإنجليزية', nameEn: 'English', icon: 'translate', sortOrder: 4 },
    { nameAr: 'البرمجة', nameEn: 'Programming', icon: 'code', sortOrder: 5 },
  ];
  const subjects: Record<string, { id: string }> = {};
  for (const def of subjectDefs) {
    const existing = await prisma.subject.findFirst({ where: { nameEn: def.nameEn } });
    subjects[def.nameEn] = existing
      ? await prisma.subject.update({ where: { id: existing.id }, data: def })
      : await prisma.subject.create({ data: def });
  }

  const gradeDefs = [
    { code: 'prep-3', nameAr: 'الصف الثالث الإعدادي', nameEn: 'Preparatory 3', sortOrder: 1 },
    { code: 'sec-1', nameAr: 'الصف الأول الثانوي', nameEn: 'Secondary 1', sortOrder: 2 },
    { code: 'sec-2', nameAr: 'الصف الثاني الثانوي', nameEn: 'Secondary 2', sortOrder: 3 },
    { code: 'sec-3', nameAr: 'الصف الثالث الثانوي (ثانوية عامة)', nameEn: 'Secondary 3', sortOrder: 4 },
  ];
  const grades: Record<string, { id: string }> = {};
  for (const def of gradeDefs) {
    grades[def.code] = await prisma.gradeLevel.upsert({
      where: { code: def.code },
      update: def,
      create: def,
    });
  }

  // ── Super admin ───────────────────────────────────────────────────────
  const adminPassword = await argon2.hash('Admin@12345');
  await prisma.user.upsert({
    where: { email: 'admin@darsly.app' },
    update: { passwordHash: adminPassword },
    create: {
      role: 'SUPER_ADMIN',
      email: 'admin@darsly.app',
      phone: '+201000000001',
      passwordHash: adminPassword,
      fullName: 'مدير منصة درسلي',
      locale: 'ar',
    },
  });

  // ── Teachers ──────────────────────────────────────────────────────────
  const teacherPassword = await argon2.hash('Teacher@12345');

  const khaledUser = await prisma.user.upsert({
    where: { email: 'khaled@darsly.app' },
    update: { passwordHash: teacherPassword },
    create: {
      role: 'TEACHER',
      email: 'khaled@darsly.app',
      phone: '+201000000002',
      passwordHash: teacherPassword,
      fullName: 'أ. د. خالد عبدالرحمن',
    },
  });
  const khaled = await prisma.teacherProfile.upsert({
    where: { userId: khaledUser.id },
    update: { status: 'APPROVED' },
    create: {
      userId: khaledUser.id,
      slug: 'khaled-abdelrahman',
      bio: 'خبير رياضيات - ثانوية عامة. متخصص في تبسيط المفاهيم الرياضية المعقدة لطلاب الثانوية.',
      subjectId: subjects['Mathematics'].id,
      status: 'APPROVED',
      verifiedAt: new Date(),
      commissionPercent: 20,
      grades: {
        create: [{ gradeId: grades['sec-2'].id }, { gradeId: grades['sec-3'].id }],
      },
    },
  });

  const nouraUser = await prisma.user.upsert({
    where: { email: 'noura@darsly.app' },
    update: { passwordHash: teacherPassword },
    create: {
      role: 'TEACHER',
      email: 'noura@darsly.app',
      phone: '+201000000003',
      passwordHash: teacherPassword,
      fullName: 'أ. نورة الخالد',
    },
  });
  const noura = await prisma.teacherProfile.upsert({
    where: { userId: nouraUser.id },
    update: { status: 'APPROVED' },
    create: {
      userId: nouraUser.id,
      slug: 'noura-alkhaled',
      bio: 'مدرسة كيمياء للثانوية العامة. شرح وافٍ مع مراجعات شاملة قبل الامتحانات.',
      subjectId: subjects['Chemistry'].id,
      status: 'APPROVED',
      verifiedAt: new Date(),
      commissionPercent: 15,
      autoApproveEnrollments: true,
      grades: {
        create: [{ gradeId: grades['sec-3'].id }],
      },
    },
  });

  // ── Courses > Units > Lessons ─────────────────────────────────────────
  async function ensureCourse(input: {
    tenantId: string;
    title: string;
    description: string;
    subjectId: string;
    gradeId: string;
    priceCents: number;
    pricingModel?: 'ONE_TIME' | 'MONTHLY_SUBSCRIPTION';
    requiresApproval?: boolean;
    units: { title: string; lessons: { title: string; durationSec: number; isFreePreview?: boolean }[] }[];
  }) {
    let course = await prisma.course.findFirst({
      where: { tenantId: input.tenantId, title: input.title },
    });
    if (course) return course;

    course = await prisma.course.create({
      data: {
        tenantId: input.tenantId,
        title: input.title,
        description: input.description,
        subjectId: input.subjectId,
        gradeId: input.gradeId,
        priceCents: input.priceCents,
        pricingModel: input.pricingModel ?? 'ONE_TIME',
        requiresEnrollmentApproval: input.requiresApproval ?? true,
        status: 'PUBLISHED',
      },
    });
    for (const [ui, unit] of input.units.entries()) {
      const createdUnit = await prisma.courseUnit.create({
        data: { courseId: course.id, title: unit.title, sortOrder: ui },
      });
      for (const [li, lesson] of unit.lessons.entries()) {
        await prisma.lesson.create({
          data: {
            unitId: createdUnit.id,
            title: lesson.title,
            sortOrder: li,
            durationSec: lesson.durationSec,
            isFreePreview: lesson.isFreePreview ?? false,
            type: 'VIDEO',
          },
        });
      }
    }
    return course;
  }

  const algebraCourse = await ensureCourse({
    tenantId: khaled.id,
    title: 'الجبر المتقدم - ثانوية عامة',
    description: 'المعادلات التربيعية وتطبيقاتها، المصفوفات، والمحددات — منهج الصف الثالث الثانوي كاملاً.',
    subjectId: subjects['Mathematics'].id,
    gradeId: grades['sec-3'].id,
    priceCents: 45000, // 450 EGP
    units: [
      {
        title: 'مقدمة في الجبر الخطي',
        lessons: [
          { title: 'الدرس الأول: أساسيات الجبر الخطي', durationSec: 2700, isFreePreview: true },
          { title: 'الدرس الثاني: العمليات على المصفوفات', durationSec: 1920 },
          { title: 'الدرس الثالث: المحددات', durationSec: 1500 },
        ],
      },
      {
        title: 'الفضاءات المتجهة',
        lessons: [
          { title: 'مقدمة في المتجهات', durationSec: 2100 },
          { title: 'الضرب القياسي والاتجاهي', durationSec: 1800 },
        ],
      },
    ],
  });

  await ensureCourse({
    tenantId: khaled.id,
    title: 'حساب المثلثات - الصف الثاني الثانوي',
    description: 'شرح شامل لحساب المثلثات مع حل نماذج امتحانات.',
    subjectId: subjects['Mathematics'].id,
    gradeId: grades['sec-2'].id,
    priceCents: 30000,
    units: [
      {
        title: 'الدوال المثلثية',
        lessons: [
          { title: 'الزوايا والقياس الدائري', durationSec: 1860, isFreePreview: true },
          { title: 'دوال الجيب وجيب التمام', durationSec: 2220 },
        ],
      },
    ],
  });

  const chemCourse = await ensureCourse({
    tenantId: noura.id,
    title: 'الكيمياء العضوية - ثانوية عامة',
    description: 'الهيدروكربونات، الكحولات، والأحماض الكربوكسيلية مع مراجعة شاملة للامتحان النصفي.',
    subjectId: subjects['Chemistry'].id,
    gradeId: grades['sec-3'].id,
    priceCents: 40000,
    pricingModel: 'MONTHLY_SUBSCRIPTION',
    requiresApproval: false,
    units: [
      {
        title: 'الهيدروكربونات',
        lessons: [
          { title: 'الألكانات والألكينات', durationSec: 2400, isFreePreview: true },
          { title: 'المركبات الأروماتية', durationSec: 2040 },
        ],
      },
      {
        title: 'المجموعات الوظيفية',
        lessons: [
          { title: 'الكحولات والفينولات', durationSec: 1980 },
          { title: 'الأحماض الكربوكسيلية', durationSec: 2160 },
        ],
      },
    ],
  });

  // ── Students ──────────────────────────────────────────────────────────
  const studentDefs = [
    { phone: '+201011111111', fullName: 'أحمد محمود', grade: 'sec-3', interests: ['Mathematics', 'Chemistry'] },
    { phone: '+201022222222', fullName: 'سارة محمد', grade: 'sec-3', interests: ['Chemistry'] },
    { phone: '+201033333333', fullName: 'عمر فاروق', grade: 'sec-2', interests: ['Mathematics', 'Physics'] },
    { phone: '+201044444444', fullName: 'منى حسن', grade: 'sec-3', interests: ['English'] },
    { phone: '+201055555555', fullName: 'يوسف علي', grade: 'prep-3', interests: ['Programming'] },
  ];

  const students: { id: string; userId: string }[] = [];
  for (const def of studentDefs) {
    const user = await prisma.user.upsert({
      where: { phone: def.phone },
      update: {},
      create: { role: 'STUDENT', phone: def.phone, fullName: def.fullName },
    });
    const profile = await prisma.studentProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        gradeId: grades[def.grade].id,
        interests: {
          create: def.interests.map((s) => ({ subjectId: subjects[s].id })),
        },
      },
    });
    students.push({ id: profile.id, userId: user.id });
  }

  // ── Enrollments: first two students in Khaled's algebra + Noura's chem ─
  await prisma.enrollment.upsert({
    where: { studentId_courseId: { studentId: students[0].id, courseId: algebraCourse.id } },
    update: {},
    create: {
      studentId: students[0].id,
      courseId: algebraCourse.id,
      tenantId: khaled.id,
      status: 'ACTIVE',
      approvedAt: new Date(),
    },
  });
  await prisma.enrollment.upsert({
    where: { studentId_courseId: { studentId: students[1].id, courseId: chemCourse.id } },
    update: {},
    create: {
      studentId: students[1].id,
      courseId: chemCourse.id,
      tenantId: noura.id,
      status: 'ACTIVE',
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), // monthly subscription
    },
  });

  // ── Platform settings ─────────────────────────────────────────────────
  await prisma.platformSetting.upsert({
    where: { key: 'commission.defaultPercent' },
    update: {},
    create: { key: 'commission.defaultPercent', value: 20 },
  });
  await prisma.platformSetting.upsert({
    where: { key: 'payout.minimumCents' },
    update: {},
    create: { key: 'payout.minimumCents', value: 50000 }, // 500 EGP, per design
  });

  console.log(`
Seed complete ✅
──────────────────────────────────────────────
 Super admin : admin@darsly.app  / Admin@12345
 Teacher 1   : khaled@darsly.app / Teacher@12345  (math, 20% commission)
 Teacher 2   : noura@darsly.app  / Teacher@12345  (chem, 15%, auto-approve)
 Students    : +201011111111 … +201055555555 (OTP dev code: 0000)
 Courses     : 3 published (7 units / 11 lessons), 2 active enrollments
──────────────────────────────────────────────`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
