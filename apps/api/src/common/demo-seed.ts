/**
 * Demo dataset generator (Academy SaaS model). WIPES all data, then creates:
 * 1 admin, 5 academies (each an owner-teacher), 12 students per academy with
 * courses, lessons, enrolments, verified payments (wallet balances) and reviews.
 *
 * Single password for EVERYONE: Darsly@123
 *
 * Shared by the CLI seed (prisma/seed.ts) and the admin reseed endpoint, so both
 * produce the identical dataset. Accepts any PrismaClient-compatible client.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

type Db = PrismaClient;

export const DEMO_PASSWORD = 'Darsly@123';
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]): T => a[rand(a.length)];

const SUBJECTS = [
  { key: 'math', nameAr: 'الرياضيات', nameEn: 'Mathematics', icon: 'calculate' },
  { key: 'physics', nameAr: 'الفيزياء', nameEn: 'Physics', icon: 'science' },
  { key: 'chem', nameAr: 'الكيمياء', nameEn: 'Chemistry', icon: 'experiment' },
  { key: 'bio', nameAr: 'الأحياء', nameEn: 'Biology', icon: 'biotech' },
  { key: 'arabic', nameAr: 'اللغة العربية', nameEn: 'Arabic', icon: 'menu_book' },
  { key: 'english', nameAr: 'اللغة الإنجليزية', nameEn: 'English', icon: 'translate' },
];
const GRADES = [
  { code: 'prep-3', nameAr: 'الثالث الإعدادي', nameEn: 'Prep 3' },
  { code: 'sec-1', nameAr: 'الأول الثانوي', nameEn: 'Secondary 1' },
  { code: 'sec-2', nameAr: 'الثاني الثانوي', nameEn: 'Secondary 2' },
  { code: 'sec-3', nameAr: 'الثالث الثانوي', nameEn: 'Secondary 3' },
];
const TEACHERS = [
  { name: 'أ. خالد عبدالرحمن', slug: 'khaled-academy', subject: 'math', color: '#4A32C9', tagline: 'الرياضيات ببساطة ووضوح' },
  { name: 'أ. نورة الخالد', slug: 'noura-academy', subject: 'chem', color: '#0F766E', tagline: 'الكيمياء بشكل تفاعلي وممتع' },
  { name: 'أ. أحمد فؤاد', slug: 'ahmed-academy', subject: 'physics', color: '#B45309', tagline: 'الفيزياء من واقع الحياة' },
  { name: 'أ. منى سمير', slug: 'mona-academy', subject: 'bio', color: '#15803D', tagline: 'الأحياء خطوة بخطوة' },
  { name: 'أ. يوسف حسن', slug: 'youssef-academy', subject: 'english', color: '#BE123C', tagline: 'الإنجليزية بثقة وطلاقة' },
];
const COURSE_TEMPLATES = [
  { suffix: 'التأسيسي', price: 30000, model: 'ONE_TIME' },
  { suffix: 'المتقدم', price: 45000, model: 'ONE_TIME' },
  { suffix: 'المراجعة النهائية', price: 60000, model: 'ONE_TIME' },
  { suffix: '— اشتراك شهري', price: 25000, model: 'MONTHLY_SUBSCRIPTION' },
];
const FIRST = ['محمد', 'أحمد', 'سارة', 'مريم', 'يوسف', 'عمر', 'ليلى', 'نور', 'حسن', 'فاطمة', 'خالد', 'هبة', 'كريم', 'دينا', 'طارق', 'رنا', 'سيف', 'ملك', 'زياد', 'جنى'];
const LAST = ['المصري', 'عبدالله', 'حسن', 'إبراهيم', 'سالم', 'فتحي', 'رشدي', 'عادل', 'مصطفى', 'يوسف', 'كمال', 'شعبان', 'زكي', 'نبيل', 'فوزي'];
const REVIEW_COMMENTS = ['شرح ممتاز وواضح', 'استفدت كتير من الكورس', 'أفضل مدرّس', 'المحتوى منظّم جداً', 'أسلوب رائع في التبسيط'];

async function wipe(prisma: Db) {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  return rows.length;
}

export async function seedDatabase(prisma: Db, log: (m: string) => void = () => {}) {
  const wiped = await wipe(prisma);
  log(`wiped ${wiped} tables`);
  const hash = await argon2.hash(DEMO_PASSWORD);

  const subjects: Record<string, string> = {};
  for (let i = 0; i < SUBJECTS.length; i++) {
    const s = await prisma.subject.create({ data: { nameAr: SUBJECTS[i].nameAr, nameEn: SUBJECTS[i].nameEn, icon: SUBJECTS[i].icon, sortOrder: i } });
    subjects[SUBJECTS[i].key] = s.id;
  }
  const grades: string[] = [];
  for (let i = 0; i < GRADES.length; i++) {
    const g = await prisma.gradeLevel.create({ data: { ...GRADES[i], sortOrder: i } });
    grades.push(g.id);
  }

  await prisma.user.create({ data: { role: 'SUPER_ADMIN', email: 'admin@darsly.app', passwordHash: hash, fullName: 'مدير المنصّة' } });

  await prisma.platformPaymentAccount.createMany({
    data: [
      { method: 'INSTAPAY', label: 'إنستاباي درسلي', handle: 'darsly@instapay', instructions: 'حوّل ثم ارفع لقطة الشاشة', sortOrder: 0 },
      { method: 'VODAFONE_CASH', label: 'فودافون كاش درسلي', handle: '01000000000', instructions: 'حوّل على المحفظة ثم ارفع الإثبات', sortOrder: 1 },
    ],
  });
  await prisma.platformSetting.create({ data: { key: 'payout.minimumCents', value: 50000 } });

  const students: { id: string; userId: string }[] = [];
  const totalStudents = TEACHERS.length * 12;
  for (let i = 0; i < totalStudents; i++) {
    const user = await prisma.user.create({ data: { role: 'STUDENT', email: `student${i + 1}@darsly.app`, passwordHash: hash, fullName: `${pick(FIRST)} ${pick(LAST)}` } });
    const profile = await prisma.studentProfile.create({ data: { userId: user.id, gradeId: pick(grades), currentStreak: rand(12), longestStreak: rand(30) } });
    students.push({ id: profile.id, userId: user.id });
  }

  let paymentsCreated = 0;
  for (let ti = 0; ti < TEACHERS.length; ti++) {
    const T = TEACHERS[ti];
    const subjName = SUBJECTS.find((s) => s.key === T.subject)!.nameAr;
    const tUser = await prisma.user.create({ data: { role: 'TEACHER', email: `teacher${ti + 1}@darsly.app`, passwordHash: hash, fullName: T.name } });
    const tp = await prisma.teacherProfile.create({ data: { userId: tUser.id, slug: T.slug, bio: T.tagline, subjectId: subjects[T.subject], status: 'APPROVED', verifiedAt: new Date(), commissionPercent: 20 } });
    const academy = await prisma.academy.create({
      data: { id: tp.id, slug: T.slug, name: T.name.replace('أ. ', 'أكاديمية '), status: 'ACTIVE', ownerUserId: tUser.id, tagline: T.tagline, colorPrimary: T.color, colorAccent: T.color, feeType: 'PERCENT', feeValue: 20 },
    });
    await prisma.academyMembership.create({ data: { userId: tUser.id, academyId: academy.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });

    const courses: { id: string; priceCents: number }[] = [];
    for (let ci = 0; ci < COURSE_TEMPLATES.length; ci++) {
      const CT = COURSE_TEMPLATES[ci];
      const course = await prisma.course.create({
        data: { tenantId: academy.id, title: `${subjName} — ${CT.suffix}`, description: `كورس ${CT.suffix} في ${subjName} مع ${T.name}.`, subjectId: subjects[T.subject], gradeId: grades[(ti + ci) % grades.length], status: 'PUBLISHED', pricingModel: CT.model as any, priceCents: CT.price, defaultViewsCap: 3 },
      });
      for (let u = 0; u < 2; u++) {
        const unit = await prisma.courseUnit.create({ data: { courseId: course.id, title: `الوحدة ${u + 1}`, sortOrder: u } });
        for (let l = 0; l < 4; l++) {
          await prisma.lesson.create({ data: { unitId: unit.id, title: `الدرس ${u * 4 + l + 1}`, type: 'VIDEO', sortOrder: l, durationSec: 480 + rand(600), isFreePreview: u === 0 && l === 0 } });
        }
      }
      courses.push({ id: course.id, priceCents: course.priceCents });
    }

    const cohort = students.slice(ti * 12, ti * 12 + 12);
    for (const st of cohort) {
      await prisma.academyMembership.create({ data: { userId: st.userId, academyId: academy.id, role: 'STUDENT', status: 'ACTIVE', isHome: true, joinedAt: new Date() } });
      const chosen = Array.from(new Set([pick(courses), pick(courses)]));
      for (const c of chosen) {
        const enr = await prisma.enrollment.create({ data: { studentId: st.id, courseId: c.id, tenantId: academy.id, status: 'ACTIVE', approvedAt: new Date() } });
        if (Math.random() < 0.65 && c.priceCents > 0) {
          const fee = Math.round((c.priceCents * 20) / 100);
          const net = c.priceCents;
          const total = net + fee;
          const payment = await prisma.payment.create({ data: { studentId: st.id, courseId: c.id, enrollmentId: enr.id, tenantId: academy.id, amountCents: total, feeCents: fee, netCents: net, status: 'PAID', gateway: 'manual', method: pick(['INSTAPAY', 'VODAFONE_CASH']) as any, paidAt: new Date(), settledAt: new Date() } });
          await prisma.ledgerTransaction.create({
            data: { description: `enrollment payment ${payment.id}`, paymentId: payment.id, entries: { create: [
              { account: 'platform:cash', direction: 'DEBIT', amountCents: total },
              { account: 'platform:commission', direction: 'CREDIT', amountCents: fee, tenantId: academy.id },
              { account: `teacher:${academy.id}:balance`, direction: 'CREDIT', amountCents: net, tenantId: academy.id },
            ] } },
          });
          paymentsCreated++;
        }
      }
      if (Math.random() < 0.4) {
        const c = pick(courses);
        await prisma.review.create({ data: { studentId: st.id, tenantId: academy.id, courseId: c.id, rating: 4 + rand(2), comment: pick(REVIEW_COMMENTS) } }).catch(() => undefined);
      }
    }

    const cross = students.slice(((ti + 1) % TEACHERS.length) * 12, ((ti + 1) % TEACHERS.length) * 12 + 6);
    for (const st of cross) {
      await prisma.academyMembership.upsert({ where: { userId_academyId: { userId: st.userId, academyId: academy.id } }, update: {}, create: { userId: st.userId, academyId: academy.id, role: 'STUDENT', status: 'ACTIVE', isHome: false, joinedAt: new Date() } });
      const c = pick(courses);
      await prisma.enrollment.upsert({ where: { studentId_courseId: { studentId: st.id, courseId: c.id } }, update: {}, create: { studentId: st.id, courseId: c.id, tenantId: academy.id, status: 'ACTIVE', approvedAt: new Date() } });
    }
    log(`${academy.name}: ${courses.length} courses, 12 students`);
  }

  const [users, academies, coursesCount, enrolments] = await Promise.all([
    prisma.user.count(), prisma.academy.count(), prisma.course.count(), prisma.enrollment.count(),
  ]);
  const summary = { users, academies, courses: coursesCount, enrolments, payments: paymentsCreated, password: DEMO_PASSWORD };
  log(`done — ${JSON.stringify(summary)}`);
  return summary;
}
