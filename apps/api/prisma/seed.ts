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

  // ── Phase 2: discovery/enrollment fixtures ────────────────────────────

  // Intro videos + thumbnails so the public profiles/cards aren't bare.
  await prisma.teacherProfile.update({
    where: { id: khaled.id },
    data: { introVideoUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', language: 'ar' },
  });
  await prisma.teacherProfile.update({
    where: { id: noura.id },
    data: { introVideoUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', language: 'ar' },
  });
  // Distinct thumbnail per course so the catalog doesn't look duplicated.
  const allCourses = await prisma.course.findMany({
    where: { tenantId: { in: [khaled.id, noura.id] } },
    select: { id: true },
  });
  for (const c of allCourses) {
    await prisma.course.update({
      where: { id: c.id },
      data: { thumbnailUrl: `https://picsum.photos/seed/darsly-${c.id.slice(-6)}/640/360` },
    });
  }

  // English-language teacher (exercises the language filter) …
  const davidUser = await prisma.user.upsert({
    where: { email: 'david@darsly.app' },
    update: { passwordHash: teacherPassword },
    create: {
      role: 'TEACHER',
      email: 'david@darsly.app',
      phone: '+201000000004',
      passwordHash: teacherPassword,
      fullName: 'Mr. David Smith',
      locale: 'en',
    },
  });
  const david = await prisma.teacherProfile.upsert({
    where: { userId: davidUser.id },
    update: { status: 'APPROVED', language: 'en' },
    create: {
      userId: davidUser.id,
      slug: 'david-smith',
      bio: 'IELTS & TOEFL preparation. Native-level English instruction for secondary students.',
      subjectId: subjects['English'].id,
      language: 'en',
      status: 'APPROVED',
      verifiedAt: new Date(),
      commissionPercent: 20,
      grades: { create: [{ gradeId: grades['sec-3'].id }] },
    },
  });
  await ensureCourse({
    tenantId: david.id,
    title: 'IELTS Intensive — Band 7+',
    description: 'Complete IELTS preparation: listening, reading, writing and speaking.',
    subjectId: subjects['English'].id,
    gradeId: grades['sec-3'].id,
    priceCents: 60000,
    units: [
      {
        title: 'Listening & Reading',
        lessons: [
          { title: 'IELTS Listening: strategies', durationSec: 2400, isFreePreview: true },
          { title: 'Academic Reading: skimming & scanning', durationSec: 2100 },
        ],
      },
    ],
  });

  // …and a PENDING teacher who must NOT appear in discovery.
  const pendingUser = await prisma.user.upsert({
    where: { email: 'pending@darsly.app' },
    update: { passwordHash: teacherPassword },
    create: {
      role: 'TEACHER',
      email: 'pending@darsly.app',
      phone: '+201000000005',
      passwordHash: teacherPassword,
      fullName: 'أ. محمد قيد المراجعة',
    },
  });
  await prisma.teacherProfile.upsert({
    where: { userId: pendingUser.id },
    update: {},
    create: {
      userId: pendingUser.id,
      slug: 'pending-teacher',
      bio: 'حساب معلم بانتظار موافقة الإدارة.',
      subjectId: subjects['Physics'].id,
      status: 'PENDING',
    },
  });

  // Coupons
  await prisma.coupon.upsert({
    where: { tenantId_code: { tenantId: khaled.id, code: 'WELCOME20' } },
    update: {},
    create: { tenantId: khaled.id, code: 'WELCOME20', percentOff: 20, maxUses: 100 },
  });
  await prisma.coupon.upsert({
    where: { tenantId_code: { tenantId: noura.id, code: 'CHEM50' } },
    update: {},
    create: {
      tenantId: noura.id,
      code: 'CHEM50',
      amountOffCents: 5000,
      courseId: chemCourse.id,
      maxUses: 50,
    },
  });

  // Reviews so rating filters/sorting have data.
  const reviewDefs = [
    { student: 0, tenantId: khaled.id, courseId: algebraCourse.id, rating: 5, comment: 'شرح ممتاز ومبسط، أنصح به بشدة.' },
    { student: 2, tenantId: khaled.id, courseId: null, rating: 4, comment: 'أسلوب رائع في توصيل المعلومة.' },
    { student: 1, tenantId: noura.id, courseId: chemCourse.id, rating: 5, comment: 'أفضل مدرسة كيمياء، المراجعات النهائية ممتازة.' },
    { student: 3, tenantId: noura.id, courseId: null, rating: 4, comment: 'شرح جيد جداً.' },
  ];
  for (const def of reviewDefs) {
    const existing = await prisma.review.findFirst({
      where: { studentId: students[def.student].id, tenantId: def.tenantId, courseId: def.courseId },
    });
    if (!existing) {
      await prisma.review.create({
        data: {
          studentId: students[def.student].id,
          tenantId: def.tenantId,
          courseId: def.courseId,
          rating: def.rating,
          comment: def.comment,
        },
      });
    }
  }

  // ── Phase 5: paid payments + double-entry ledger + a payout ────────────
  // Give Khaled real revenue so the wallet + admin financials show numbers.
  // Balanced entries (Σ debit === Σ credit); commission = 20%.
  async function ensurePaidPayment(studentId: string, course: { id: string; tenantId: string; priceCents: number }) {
    const existing = await prisma.payment.findFirst({
      where: { studentId, courseId: course.id, status: 'PAID' },
    });
    if (existing) return existing;
    const enrollment = await prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId: course.id } },
    });
    const payment = await prisma.payment.create({
      data: {
        studentId,
        courseId: course.id,
        enrollmentId: enrollment?.id,
        tenantId: course.tenantId,
        amountCents: course.priceCents,
        status: 'PAID',
        gateway: 'mock',
        paidAt: new Date(),
      },
    });
    const commission = Math.round((course.priceCents * 20) / 100);
    const teacherShare = course.priceCents - commission;
    await prisma.ledgerTransaction.create({
      data: {
        description: `enrollment payment ${payment.id}`,
        paymentId: payment.id,
        entries: {
          create: [
            { account: 'platform:cash', direction: 'DEBIT', amountCents: course.priceCents },
            { account: 'platform:commission', direction: 'CREDIT', amountCents: commission, tenantId: course.tenantId },
            { account: `teacher:${course.tenantId}:balance`, direction: 'CREDIT', amountCents: teacherShare, tenantId: course.tenantId },
          ],
        },
      },
    });
    const invCount = await prisma.invoice.count();
    await prisma.invoice.create({
      data: { paymentId: payment.id, serial: `DRS-INV-${new Date().getFullYear()}-${String(invCount + 1).padStart(6, '0')}` },
    });
    return payment;
  }

  // 3 students pay for Khaled's algebra (450 EGP each) → he nets 360 EGP each.
  for (const s of students.slice(0, 3)) {
    await ensurePaidPayment(s.id, { id: algebraCourse.id, tenantId: khaled.id, priceCents: 45000 });
  }
  // Noura's chem (400 EGP monthly) — one paid.
  await ensurePaidPayment(students[1].id, { id: chemCourse.id, tenantId: noura.id, priceCents: 40000 });

  // A saved payout method + one pending request for Khaled.
  const khaledMethod = await prisma.payoutMethodSaved.findFirst({ where: { tenantId: khaled.id } });
  if (!khaledMethod) {
    await prisma.payoutMethodSaved.create({
      data: {
        tenantId: khaled.id,
        method: 'INSTAPAY',
        details: { handle: 'khaled@instapay', displayName: 'خالد عبدالرحمن' },
        isDefault: true,
      },
    });
  }
  const existingPayout = await prisma.payoutRequest.findFirst({ where: { tenantId: khaled.id } });
  if (!existingPayout) {
    await prisma.payoutRequest.create({
      data: {
        tenantId: khaled.id,
        amountCents: 60000, // 600 EGP
        method: 'INSTAPAY',
        destination: { handle: 'khaled@instapay' },
        status: 'REQUESTED',
      },
    });
  }

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
 Teacher 3   : david@darsly.app  / Teacher@12345  (english, language=en)
 Teacher 4   : pending@darsly.app (PENDING — hidden from discovery)
 Students    : +201011111111 … +201055555555 (OTP dev code: 0000)
 Courses     : 4 published, 2 active enrollments
 Coupons     : WELCOME20 (khaled, 20%), CHEM50 (noura, 50 EGP off chem)
 Reviews     : 4 (khaled avg 4.5, noura avg 4.5)
──────────────────────────────────────────────`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
