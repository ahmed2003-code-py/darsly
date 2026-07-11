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

  // ── Students (email + password, like everyone else) ───────────────────
  const studentPassword = await argon2.hash('Student@12345');
  const studentDefs = [
    { email: 'ahmed@student.darsly.app', phone: '+201011111111', fullName: 'أحمد محمود', grade: 'sec-3', interests: ['Mathematics', 'Chemistry'] },
    { email: 'sara@student.darsly.app', phone: '+201022222222', fullName: 'سارة محمد', grade: 'sec-3', interests: ['Chemistry'] },
    { email: 'omar@student.darsly.app', phone: '+201033333333', fullName: 'عمر فاروق', grade: 'sec-2', interests: ['Mathematics', 'Physics'] },
    { email: 'mona@student.darsly.app', phone: '+201044444444', fullName: 'منى حسن', grade: 'sec-3', interests: ['English'] },
    { email: 'youssef@student.darsly.app', phone: '+201055555555', fullName: 'يوسف علي', grade: 'prep-3', interests: ['Programming'] },
  ];

  const students: { id: string; userId: string }[] = [];
  for (const def of studentDefs) {
    const user = await prisma.user.upsert({
      where: { email: def.email },
      update: { passwordHash: studentPassword, phone: def.phone },
      create: {
        role: 'STUDENT',
        email: def.email,
        phone: def.phone,
        fullName: def.fullName,
        passwordHash: studentPassword,
      },
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

  // ── Demo enrichment: populate every screen for a live walkthrough ──────
  // Idempotent: each block guards on an existing row before creating.

  // More enrollments so the catalog + approval queue + rosters look alive.
  async function ensureEnrollment(studentIdx: number, courseId: string, tenantId: string,
    status: 'ACTIVE' | 'PENDING_APPROVAL', expiresAt?: Date) {
    return prisma.enrollment.upsert({
      where: { studentId_courseId: { studentId: students[studentIdx].id, courseId } },
      update: {},
      create: {
        studentId: students[studentIdx].id, courseId, tenantId, status,
        approvedAt: status === 'ACTIVE' ? new Date() : null, expiresAt,
      },
    });
  }
  await ensureEnrollment(3, algebraCourse.id, khaled.id, 'ACTIVE');
  await ensureEnrollment(4, algebraCourse.id, khaled.id, 'ACTIVE');
  await ensureEnrollment(2, algebraCourse.id, khaled.id, 'PENDING_APPROVAL'); // approval queue
  await ensureEnrollment(3, chemCourse.id, noura.id, 'PENDING_APPROVAL');
  // Paid sales for the two extra active students so the ledger/wallet/dashboard
  // revenue reflects real, consistent numbers.
  await ensurePaidPayment(students[3].id, { id: algebraCourse.id, tenantId: khaled.id, priceCents: 45000 });
  await ensurePaidPayment(students[4].id, { id: algebraCourse.id, tenantId: khaled.id, priceCents: 45000 });

  // A quiz + an assignment lesson on Khaled's algebra course.
  const demoUnit = await prisma.courseUnit.findFirst({
    where: { courseId: algebraCourse.id, title: 'تقييمات ومراجعات' },
  }) ?? await prisma.courseUnit.create({
    data: { courseId: algebraCourse.id, title: 'تقييمات ومراجعات', sortOrder: 90 },
  });

  const quizLesson = await prisma.lesson.findFirst({
    where: { unitId: demoUnit.id, type: 'QUIZ' },
  }) ?? await prisma.lesson.create({
    data: { unitId: demoUnit.id, title: 'اختبار: أساسيات الجبر', type: 'QUIZ', sortOrder: 0 },
  });
  const quiz = await prisma.quiz.upsert({
    where: { lessonId: quizLesson.id },
    update: {},
    create: { lessonId: quizLesson.id, passingScore: 60 },
  });
  if ((await prisma.quizQuestion.count({ where: { quizId: quiz.id } })) === 0) {
    await prisma.quizQuestion.createMany({
      data: [
        { quizId: quiz.id, type: 'MCQ', prompt: 'ما ناتج ٥ × ٦؟', options: [{ id: 'a', text: '٣٠' }, { id: 'b', text: '٣٥' }, { id: 'c', text: '٢٥' }], correctOptionId: 'a', explanation: '٥ × ٦ = ٣٠.', points: 2, sortOrder: 0 },
        { quizId: quiz.id, type: 'TRUE_FALSE', prompt: 'المعادلة الخطية درجتها الأولى.', options: [{ id: 'true', text: 'صح' }, { id: 'false', text: 'خطأ' }], correctOptionId: 'true', points: 1, sortOrder: 1 },
        { quizId: quiz.id, type: 'SHORT_ANSWER', prompt: 'عرّف المتغيّر في المعادلة.', points: 2, sortOrder: 2 },
      ],
    });
  }
  // A graded attempt by أحمد so the teacher's grading view has content.
  if ((await prisma.quizAttempt.count({ where: { quizId: quiz.id, studentId: students[0].id } })) === 0) {
    const qs = await prisma.quizQuestion.findMany({ where: { quizId: quiz.id }, orderBy: { sortOrder: 'asc' } });
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id, studentId: students[0].id,
        answers: { [qs[0].id]: 'a', [qs[1].id]: 'true', [qs[2].id]: 'المتغيّر رمز يمثّل قيمة مجهولة.' },
        scorePct: 100, passed: true, needsManualGrading: false, submittedAt: new Date(), gradedAt: new Date(),
      },
    });
  }

  const assignLesson = await prisma.lesson.findFirst({
    where: { unitId: demoUnit.id, type: 'ASSIGNMENT' },
  }) ?? await prisma.lesson.create({
    data: { unitId: demoUnit.id, title: 'واجب: حل تمارين الوحدة', type: 'ASSIGNMENT', sortOrder: 1 },
  });
  const assignment = await prisma.assignment.upsert({
    where: { lessonId: assignLesson.id },
    update: {},
    create: { lessonId: assignLesson.id, prompt: 'حل التمارين ١ إلى ١٠ من كتاب الجبر وارفع خطوات الحل.', maxScore: 20 },
  });
  if ((await prisma.assignmentSubmission.count({ where: { assignmentId: assignment.id } })) === 0) {
    await prisma.assignmentSubmission.create({
      data: { assignmentId: assignment.id, studentId: students[1].id, body: 'تم حل جميع التمارين المطلوبة مع خطوات الحل.', score: 18, feedback: 'حل ممتاز، انتبه لخطوة التبسيط الأخيرة.', gradedAt: new Date() },
    });
  }

  // Lesson progress: أحمد completes every algebra lesson → gets a certificate;
  // عمر has an in-progress lesson so "continue watching" isn't empty.
  const algebraLessons = await prisma.lesson.findMany({ where: { unit: { courseId: algebraCourse.id } } });
  for (const l of algebraLessons) {
    await prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: students[0].id, lessonId: l.id } },
      update: {},
      create: { studentId: students[0].id, lessonId: l.id, watchedPct: 100, completedAt: new Date(), lastPositionSec: l.durationSec },
    });
  }
  if (algebraLessons[0]) {
    await prisma.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: students[3].id, lessonId: algebraLessons[0].id } },
      update: {},
      create: { studentId: students[3].id, lessonId: algebraLessons[0].id, watchedPct: 42, lastPositionSec: Math.round((algebraLessons[0].durationSec || 600) * 0.42) },
    });
  }
  await prisma.studentProfile.update({
    where: { id: students[0].id },
    data: { currentStreak: 6, longestStreak: 9, lastActivityDate: new Date(), weeklyGoalLessons: 5 },
  });

  // Completion certificate for أحمد.
  if (!(await prisma.certificate.findFirst({ where: { studentId: students[0].id, courseId: algebraCourse.id } }))) {
    const certCount = await prisma.certificate.count();
    await prisma.certificate.create({
      data: { studentId: students[0].id, courseId: algebraCourse.id, serial: `DRS-CERT-${new Date().getFullYear()}-${String(certCount + 1).padStart(6, '0')}` },
    });
  }

  // Chat threads so the Messages page has live-looking conversations.
  async function ensureThread(tenantId: string, teacherUserId: string, studentIdx: number, msgs: [boolean, string][]) {
    let thread = await prisma.chatThread.findFirst({ where: { tenantId, studentId: students[studentIdx].id, type: 'DM' } });
    if (!thread) thread = await prisma.chatThread.create({ data: { type: 'DM', tenantId, studentId: students[studentIdx].id } });
    if ((await prisma.chatMessage.count({ where: { threadId: thread.id } })) === 0) {
      let t = Date.now() - msgs.length * 3_600_000;
      for (const [fromTeacher, body] of msgs) {
        await prisma.chatMessage.create({
          data: { threadId: thread.id, senderId: fromTeacher ? teacherUserId : students[studentIdx].userId, body, createdAt: new Date(t) },
        });
        t += 3_600_000;
      }
      await prisma.chatThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    }
  }
  await ensureThread(khaled.id, khaled.userId, 0, [
    [false, 'أستاذ خالد، مش فاهم خطوة التبسيط في المثال الثالث.'],
    [true, 'أهلاً أحمد، ابسط الطرفين بقسمة على ٢ الأول، وبعدها كمل عادي.'],
    [false, 'تمام وصلت، شكراً جزيلاً!'],
  ]);
  await ensureThread(noura.id, noura.userId, 1, [
    [false, 'دكتورة نورا، هل المراجعة النهائية بتغطي الباب الرابع؟'],
    [true, 'أيوة يا سارة، بتغطي كل الأبواب مع أهم المسائل.'],
  ]);

  // Notifications so the bell isn't empty.
  async function ensureNotif(userId: string, type: string, title: string, body: string) {
    if (!(await prisma.notification.findFirst({ where: { userId, title } }))) {
      await prisma.notification.create({ data: { userId, type: type as any, title, body } });
    }
  }
  await ensureNotif(students[0].userId, 'ENROLLMENT_APPROVED', 'تم قبول التحاقك 🎉', 'تم تفعيل اشتراكك في دورة أساسيات الجبر.');
  await ensureNotif(students[0].userId, 'ANNOUNCEMENT', 'مبروك! حصلت على شهادة 🎓', 'أتممت دورة أساسيات الجبر — شهادتك جاهزة.');
  await ensureNotif(khaled.userId, 'ANNOUNCEMENT', 'تقييم جديد ⭐', 'حصلت دورة أساسيات الجبر على تقييم 5/5.');
  await ensureNotif(khaled.userId, 'CHAT_MESSAGE', 'رسالة جديدة من أحمد محمود', 'مش فاهم خطوة التبسيط في المثال الثالث.');

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
Seed complete ✅  — everyone logs in with EMAIL + PASSWORD
──────────────────────────────────────────────
 Super admin : admin@darsly.app          / Admin@12345
 Teacher 1   : khaled@darsly.app         / Teacher@12345  (math, 20% commission)
 Teacher 2   : noura@darsly.app          / Teacher@12345  (chem, 15%, auto-approve)
 Teacher 3   : david@darsly.app          / Teacher@12345  (english, language=en)
 Teacher 4   : pending@darsly.app        / Teacher@12345  (PENDING — cannot log in yet)
 Students    : ahmed@student.darsly.app  / Student@12345  (+ sara/omar/mona/youssef)
──────────────────────────────────────────────
 Demo data   : quiz+assignment (graded), certificate for أحمد, 6 enrollments
               (2 pending approval), chat threads, notifications, progress+streak
──────────────────────────────────────────────`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
