/**
 * Demo dataset generator (Academy SaaS model). WIPES all data, then builds a rich,
 * presentation-ready dataset that exercises EVERY user-facing feature:
 *   • 1 admin, 6 academies (owner-teacher each) with real avatars, branded covers
 *   • Subjects + grade levels, clear Arabic names
 *   • Courses with subject-relevant cover photos, units, and a MIX of lesson types
 *     (video / quiz / assignment), free-preview lessons, and downloadable attachments
 *   • Quizzes with all 3 question types (MCQ / true-false / short-answer) + attempts
 *   • Assignments with graded student submissions
 *   • Enrolments, verified+settled payments (wallet balances), reviews, coupons
 *   • Lesson progress, completed courses → completion certificates (verify tokens)
 *   • Upcoming live sessions with bookings, and student↔teacher chat threads
 *
 * Single password for EVERYONE: Darsly@123
 *
 * Shared by the CLI seed (prisma/seed.ts) and the admin reseed endpoint, so both
 * produce the identical dataset. Accepts any PrismaClient-compatible client.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

type Db = PrismaClient;

export const DEMO_PASSWORD = 'Darsly@123';
const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(a: T[]): T => a[rand(a.length)];
const chance = (p: number) => Math.random() < p;
/** Realistic face photos, deterministic per index (pravatar has ~70 images). */
const avatar = (n: number) => `https://i.pravatar.cc/300?img=${(n % 70) + 1}`;
const token = () => randomBytes(16).toString('base64url');

const SUBJECTS = [
  { key: 'math', nameAr: 'الرياضيات', nameEn: 'Mathematics', icon: 'calculate' },
  { key: 'physics', nameAr: 'الفيزياء', nameEn: 'Physics', icon: 'science' },
  { key: 'chem', nameAr: 'الكيمياء', nameEn: 'Chemistry', icon: 'experiment' },
  { key: 'bio', nameAr: 'الأحياء', nameEn: 'Biology', icon: 'biotech' },
  { key: 'arabic', nameAr: 'اللغة العربية', nameEn: 'Arabic', icon: 'menu_book' },
  { key: 'english', nameAr: 'اللغة الإنجليزية', nameEn: 'English', icon: 'translate' },
];

/** Subject-relevant cover photos (Unsplash CDN). */
const SUBJECT_COVER: Record<string, string> = {
  math: 'https://images.unsplash.com/photo-1509228468518-180dd4864904?w=800&h=450&fit=crop&q=80',
  physics: 'https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa?w=800&h=450&fit=crop&q=80',
  chem: 'https://images.unsplash.com/photo-1603126857599-f6e157fa2fe6?w=800&h=450&fit=crop&q=80',
  bio: 'https://images.unsplash.com/photo-1530026405186-ed1f139313f8?w=800&h=450&fit=crop&q=80',
  arabic: 'https://images.unsplash.com/photo-1585036156171-384164a8c675?w=800&h=450&fit=crop&q=80',
  english: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=800&h=450&fit=crop&q=80',
};

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
  { name: 'أ. سلمى إبراهيم', slug: 'salma-academy', subject: 'arabic', color: '#7C3AED', tagline: 'العربية بلاغة ونحواً' },
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

interface SeedQuestion {
  type: 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  prompt: string;
  options: { id: string; text: string }[];
  correctOptionId: string | null;
  explanation: string;
  points: number;
}
const TF = () => [{ id: 'true', text: 'صح' }, { id: 'false', text: 'خطأ' }];
/** One quiz per subject, using all three question types. */
const QUIZ_BANK: Record<string, SeedQuestion[]> = {
  math: [
    { type: 'MCQ', prompt: 'ما ناتج ٢ + ٣ × ٤ ؟', options: [{ id: 'a', text: '٢٠' }, { id: 'b', text: '١٤' }, { id: 'c', text: '٢٤' }, { id: 'd', text: '٩' }], correctOptionId: 'b', explanation: 'الضرب أولاً: ٣×٤=١٢ ثم +٢ = ١٤.', points: 2 },
    { type: 'TRUE_FALSE', prompt: 'مجموع زوايا المثلث يساوي ١٨٠ درجة.', options: TF(), correctOptionId: 'true', explanation: 'صحيح لكل مثلث في المستوى.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'اشرح نظرية فيثاغورس بإيجاز.', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
  physics: [
    { type: 'MCQ', prompt: 'ما وحدة قياس القوة؟', options: [{ id: 'a', text: 'نيوتن' }, { id: 'b', text: 'جول' }, { id: 'c', text: 'واط' }, { id: 'd', text: 'باسكال' }], correctOptionId: 'a', explanation: 'القوة تُقاس بالنيوتن (N).', points: 2 },
    { type: 'TRUE_FALSE', prompt: 'سرعة الضوء في الفراغ ثابتة.', options: TF(), correctOptionId: 'true', explanation: 'ثابتة ≈ ٣×١٠⁸ م/ث.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'عرّف قانون نيوتن الأول للحركة.', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
  chem: [
    { type: 'MCQ', prompt: 'ما الرمز الكيميائي للماء؟', options: [{ id: 'a', text: 'CO₂' }, { id: 'b', text: 'O₂' }, { id: 'c', text: 'H₂O' }, { id: 'd', text: 'NaCl' }], correctOptionId: 'c', explanation: 'الماء يتكوّن من ذرتي هيدروجين وذرة أكسجين.', points: 2 },
    { type: 'TRUE_FALSE', prompt: 'العدد الذري يساوي عدد البروتونات في النواة.', options: TF(), correctOptionId: 'true', explanation: 'صحيح — العدد الذري = عدد البروتونات.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'ما الفرق بين العنصر والمركب؟', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
  bio: [
    { type: 'MCQ', prompt: 'أي عضية مسؤولة عن إنتاج الطاقة في الخلية؟', options: [{ id: 'a', text: 'النواة' }, { id: 'b', text: 'الميتوكوندريا' }, { id: 'c', text: 'الرايبوسوم' }, { id: 'd', text: 'جهاز جولجي' }], correctOptionId: 'b', explanation: 'الميتوكوندريا هي محطة توليد الطاقة.', points: 2 },
    { type: 'TRUE_FALSE', prompt: 'الخلية النباتية تحتوي على جدار خلوي.', options: TF(), correctOptionId: 'true', explanation: 'صحيح — الجدار الخلوي من السليولوز.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'اشرح عملية البناء الضوئي بإيجاز.', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
  arabic: [
    { type: 'MCQ', prompt: 'ما إعراب «الطالبُ» في جملة: نجح الطالبُ؟', options: [{ id: 'a', text: 'فاعل مرفوع' }, { id: 'b', text: 'مفعول به' }, { id: 'c', text: 'مبتدأ' }, { id: 'd', text: 'خبر' }], correctOptionId: 'a', explanation: 'فاعل مرفوع وعلامة رفعه الضمة.', points: 2 },
    { type: 'TRUE_FALSE', prompt: 'الفعل الماضي مبني دائماً.', options: TF(), correctOptionId: 'true', explanation: 'صحيح — الفعل الماضي مبني.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'اذكر أنواع الجموع في اللغة العربية مع مثال.', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
  english: [
    { type: 'MCQ', prompt: 'Choose the correct past tense of “go”.', options: [{ id: 'a', text: 'goed' }, { id: 'b', text: 'gone' }, { id: 'c', text: 'went' }, { id: 'd', text: 'going' }], correctOptionId: 'c', explanation: '“went” is the simple past of “go”.', points: 2 },
    { type: 'TRUE_FALSE', prompt: '“They is happy” is grammatically correct.', options: TF(), correctOptionId: 'false', explanation: 'It should be “They are happy”.', points: 1 },
    { type: 'SHORT_ANSWER', prompt: 'Write one sentence using the present perfect tense.', options: [], correctOptionId: null, explanation: '', points: 3 },
  ],
};

const ASSIGN_PROMPT: Record<string, string> = {
  math: 'حل تمارين الوحدة الثانية (المسائل ١-١٠) واكتب خطوات الحل بالتفصيل.',
  physics: 'اكتب تقريراً قصيراً عن تطبيق عملي لقوانين نيوتن في الحياة اليومية.',
  chem: 'اكتب معادلات موزونة لثلاثة تفاعلات كيميائية من دروس الوحدة.',
  bio: 'ارسم مخططاً لعملية البناء الضوئي واشرح مراحلها بإيجاز.',
  arabic: 'أعرب الجمل الخمس المرفقة إعراباً كاملاً.',
  english: 'Write a 120-word paragraph about your favourite hobby using the past tense.',
};

const CHAT_LINES = [
  ['عندي سؤال في الدرس الثالث، ممكن توضّح؟', 'أكيد، الفكرة إن…', 'تمام، وصلت المعلومة، شكراً جزيلاً!'],
  ['أستاذ، الامتحان صعب شوية 😅', 'ركّز على الأمثلة المحلولة وهتلاقيه أسهل.', 'حاضر، هراجع تاني.'],
  ['متى الحصة القادمة المباشرة؟', 'مجدولة الأسبوع الجاي، هتلاقيها في صفحة البث.', 'جميل، هحجز مكاني.'],
];

/** A tiny text “worksheet” written to local storage so attachment downloads work
 *  in the local demo. Best-effort — wrapped in try/catch for S3/other drivers. */
const WORKSHEET = (subjName: string) =>
  `درسـلي — ورقة عمل\nالمادة: ${subjName}\n\nحل التمارين التالية وارفع إجابتك من صفحة الواجب.\n\n1) …\n2) …\n3) …\n`;

async function writeStorageFile(key: string, body: string) {
  try {
    const root = path.resolve(process.env.STORAGE_LOCAL_PATH ?? './storage');
    const full = path.resolve(root, key);
    if (!full.startsWith(root)) return;
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  } catch {
    /* non-local storage driver — attachment metadata still shows in the UI */
  }
}

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

  await prisma.user.create({ data: { role: 'SUPER_ADMIN', email: 'admin@darsly.app', passwordHash: hash, fullName: 'مدير المنصّة', avatarUrl: avatar(11) } });

  // Global receiving accounts (money transfer targets shown to students).
  await prisma.platformPaymentAccount.createMany({
    data: [
      { method: 'INSTAPAY', label: 'إنستاباي درسلي', handle: 'darsly@instapay', instructions: 'حوّل ثم ارفع لقطة الشاشة', sortOrder: 0 },
      { method: 'VODAFONE_CASH', label: 'فودافون كاش درسلي', handle: '01000000000', instructions: 'حوّل على المحفظة ثم ارفع الإثبات', sortOrder: 1 },
    ],
  });

  const STUDENTS_PER = 12;
  const students: { id: string; userId: string; name: string }[] = [];
  const totalStudents = TEACHERS.length * STUDENTS_PER;
  for (let i = 0; i < totalStudents; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const user = await prisma.user.create({ data: { role: 'STUDENT', email: `student${i + 1}@darsly.app`, passwordHash: hash, fullName: name, avatarUrl: avatar(i + 12) } });
    const profile = await prisma.studentProfile.create({ data: { userId: user.id, gradeId: pick(grades), currentStreak: rand(12), longestStreak: rand(30) } });
    students.push({ id: profile.id, userId: user.id, name });
  }

  const stats = { payments: 0, quizzes: 0, assignments: 0, attachments: 0, certificates: 0, live: 0, chats: 0, coupons: 0 };

  for (let ti = 0; ti < TEACHERS.length; ti++) {
    const T = TEACHERS[ti];
    const subjName = SUBJECTS.find((s) => s.key === T.subject)!.nameAr;
    const cover = SUBJECT_COVER[T.subject];
    const tUser = await prisma.user.create({ data: { role: 'TEACHER', email: `teacher${ti + 1}@darsly.app`, passwordHash: hash, fullName: T.name, avatarUrl: avatar(ti + 1) } });
    const tp = await prisma.teacherProfile.create({ data: { userId: tUser.id, slug: T.slug, bio: T.tagline, subjectId: subjects[T.subject], status: 'APPROVED', verifiedAt: new Date(), commissionPercent: 20 } });
    const academy = await prisma.academy.create({
      data: { id: tp.id, slug: T.slug, name: T.name.replace('أ. ', 'أكاديمية '), status: 'ACTIVE', ownerUserId: tUser.id, tagline: T.tagline, logoUrl: avatar(ti + 1), coverUrl: cover, colorPrimary: T.color, colorAccent: T.color, feeType: 'PERCENT', feeValue: 20 },
    });
    await prisma.academyMembership.create({ data: { userId: tUser.id, academyId: academy.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });

    // ── Coupons ──────────────────────────────────────────────────────────────
    await prisma.coupon.create({ data: { tenantId: academy.id, code: 'WELCOME10', percentOff: 10, maxUses: 100, isActive: true } });
    await prisma.coupon.create({ data: { tenantId: academy.id, code: 'SAVE50', amountOffCents: 5000, maxUses: 50, isActive: true } });
    stats.coupons += 2;

    // ── Courses, units, lessons (mixed types), quizzes, assignments, attachments
    const courses: { id: string; priceCents: number; lessonIds: string[]; quizLessonId: string; quizId: string }[] = [];
    for (let ci = 0; ci < COURSE_TEMPLATES.length; ci++) {
      const CT = COURSE_TEMPLATES[ci];
      const course = await prisma.course.create({
        data: { tenantId: academy.id, title: `${subjName} — ${CT.suffix}`, description: `كورس ${CT.suffix} في ${subjName} مع ${T.name}. محتوى منظّم بالفيديو والاختبارات والواجبات.`, subjectId: subjects[T.subject], gradeId: grades[(ti + ci) % grades.length], status: 'PUBLISHED', pricingModel: CT.model as any, priceCents: CT.price, thumbnailUrl: cover, defaultViewsCap: 3 },
      });

      const lessonIds: string[] = [];
      let quizLessonId = '';
      let quizId = '';

      // Unit 1: 3 videos (first free) + 1 quiz lesson.
      const u1 = await prisma.courseUnit.create({ data: { courseId: course.id, title: 'الوحدة الأولى — التأسيس', sortOrder: 0 } });
      for (let l = 0; l < 3; l++) {
        const lesson = await prisma.lesson.create({ data: { unitId: u1.id, title: `الدرس ${l + 1}: مقدمة ${subjName}`, type: 'VIDEO', sortOrder: l, durationSec: 480 + rand(600), isFreePreview: l === 0 } });
        lessonIds.push(lesson.id);
        // Attachment on the first video lesson.
        if (l === 0) {
          const key = `demo/attachments/${lesson.id}.txt`;
          await writeStorageFile(key, WORKSHEET(subjName));
          await prisma.attachment.create({ data: { lessonId: lesson.id, fileName: `ورقة عمل — ${subjName}.txt`, storageKey: key, mimeType: 'text/plain', sizeBytes: WORKSHEET(subjName).length, downloadable: true } });
          stats.attachments++;
        }
      }
      const quizLesson = await prisma.lesson.create({ data: { unitId: u1.id, title: 'اختبار الوحدة الأولى', type: 'QUIZ', sortOrder: 3, durationSec: 0 } });
      quizLessonId = quizLesson.id;
      lessonIds.push(quizLesson.id);
      const quiz = await prisma.quiz.create({ data: { lessonId: quizLesson.id, passingScore: 60, maxAttempts: 3, shuffleQuestions: false } });
      quizId = quiz.id;
      const qs = QUIZ_BANK[T.subject];
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi];
        await prisma.quizQuestion.create({ data: { quizId: quiz.id, type: q.type as any, prompt: q.prompt, options: q.options as any, correctOptionId: q.correctOptionId, explanation: q.explanation, points: q.points, sortOrder: qi } });
      }
      stats.quizzes++;

      // Unit 2: 2 videos + 1 assignment lesson.
      const u2 = await prisma.courseUnit.create({ data: { courseId: course.id, title: 'الوحدة الثانية — التطبيق', sortOrder: 1 } });
      for (let l = 0; l < 2; l++) {
        const lesson = await prisma.lesson.create({ data: { unitId: u2.id, title: `الدرس ${l + 4}: تطبيقات ${subjName}`, type: 'VIDEO', sortOrder: l, durationSec: 480 + rand(600) } });
        lessonIds.push(lesson.id);
      }
      const asgLesson = await prisma.lesson.create({ data: { unitId: u2.id, title: 'واجب الوحدة الثانية', type: 'ASSIGNMENT', sortOrder: 2, durationSec: 0 } });
      lessonIds.push(asgLesson.id);
      const assignment = await prisma.assignment.create({ data: { lessonId: asgLesson.id, prompt: ASSIGN_PROMPT[T.subject], dueAt: new Date(Date.now() + 7 * 86_400_000), maxScore: 100 } });
      stats.assignments++;

      courses.push({ id: course.id, priceCents: course.priceCents, lessonIds, quizLessonId, quizId });
      (courses[courses.length - 1] as any).assignmentId = assignment.id;
    }

    // ── Cohort: enrolments, payments, progress, attempts, submissions, certs, chat
    const cohort = students.slice(ti * STUDENTS_PER, ti * STUDENTS_PER + STUDENTS_PER);
    for (let si = 0; si < cohort.length; si++) {
      const st = cohort[si];
      await prisma.academyMembership.create({ data: { userId: st.userId, academyId: academy.id, role: 'STUDENT', status: 'ACTIVE', isHome: true, joinedAt: new Date() } });

      const chosen = Array.from(new Set([pick(courses), pick(courses)]));
      for (const c of chosen) {
        const enr = await prisma.enrollment.create({ data: { studentId: st.id, courseId: c.id, tenantId: academy.id, status: 'ACTIVE', approvedAt: new Date() } });

        // Paid enrolment + settled ledger (wallet balance).
        if (c.priceCents > 0 && chance(0.7)) {
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
          stats.payments++;
        }

        // Progress: the first 2-3 cohort students COMPLETE the course → certificate;
        // everyone else has partial progress.
        const complete = si < 3;
        const videoLessons = c.lessonIds;
        const upto = complete ? videoLessons.length : 1 + rand(videoLessons.length);
        for (let li = 0; li < videoLessons.length; li++) {
          const done = li < upto;
          await prisma.lessonProgress.create({ data: { studentId: st.id, lessonId: videoLessons[li], watchedPct: done ? 100 : 20 + rand(60), lastPositionSec: 60 + rand(400), completedAt: done ? new Date() : null } }).catch(() => undefined);
        }
        if (complete) {
          await prisma.certificate.create({ data: { studentId: st.id, courseId: c.id, serial: `DRS-CERT-2026-${String(stats.certificates + 1).padStart(6, '0')}`, verifyToken: token() } }).catch(() => undefined);
          stats.certificates++;
        }

        // Quiz attempt on this course's quiz (most students; some pass).
        if (chance(0.6)) {
          const passed = chance(0.7);
          await prisma.quizAttempt.create({ data: { quizId: c.quizId, studentId: st.id, answers: { q1: 'b' } as any, scorePct: passed ? 70 + rand(30) : 20 + rand(30), passed, needsManualGrading: false, submittedAt: new Date() } }).catch(() => undefined);
        }

        // Assignment submission (some graded).
        if (chance(0.5) && (c as any).assignmentId) {
          const graded = chance(0.6);
          await prisma.assignmentSubmission.create({ data: { assignmentId: (c as any).assignmentId, studentId: st.id, body: 'هذه إجابتي على الواجب المطلوب مع خطوات الحل.', score: graded ? 60 + rand(40) : null, feedback: graded ? 'إجابة جيدة، انتبه للخطوة الأخيرة.' : null, gradedAt: graded ? new Date() : null } }).catch(() => undefined);
        }
      }

      // Review (some students).
      if (chance(0.45)) {
        const c = pick(chosen);
        await prisma.review.create({ data: { studentId: st.id, tenantId: academy.id, courseId: c.id, rating: 4 + rand(2), comment: pick(REVIEW_COMMENTS) } }).catch(() => undefined);
      }

      // Chat thread with the teacher (some students).
      if (chance(0.4)) {
        const thread = await prisma.chatThread.create({ data: { type: 'DM', tenantId: academy.id, studentId: st.id } });
        const lines = pick(CHAT_LINES);
        for (let mi = 0; mi < lines.length; mi++) {
          const fromStudent = mi % 2 === 0;
          await prisma.chatMessage.create({ data: { threadId: thread.id, senderId: fromStudent ? st.userId : tUser.id, body: lines[mi], readAt: mi < lines.length - 1 ? new Date() : null } });
        }
        await prisma.chatThread.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
        stats.chats++;
      }
    }

    // Cross-academy enrolments (marketplace feel).
    const cross = students.slice(((ti + 1) % TEACHERS.length) * STUDENTS_PER, ((ti + 1) % TEACHERS.length) * STUDENTS_PER + 6);
    for (const st of cross) {
      await prisma.academyMembership.upsert({ where: { userId_academyId: { userId: st.userId, academyId: academy.id } }, update: {}, create: { userId: st.userId, academyId: academy.id, role: 'STUDENT', status: 'ACTIVE', isHome: false, joinedAt: new Date() } });
      const c = pick(courses);
      await prisma.enrollment.upsert({ where: { studentId_courseId: { studentId: st.id, courseId: c.id } }, update: {}, create: { studentId: st.id, courseId: c.id, tenantId: academy.id, status: 'ACTIVE', approvedAt: new Date() } });
    }

    // ── Upcoming live sessions + bookings ──────────────────────────────────────
    for (let lv = 0; lv < 2; lv++) {
      const session = await prisma.liveSession.create({
        data: { tenantId: academy.id, courseId: courses[lv % courses.length].id, title: `بث مباشر: مراجعة ${subjName} (${lv + 1})`, description: 'حصة مباشرة لمراجعة أهم النقاط والإجابة على الأسئلة.', startsAt: new Date(Date.now() + (lv + 1) * 2 * 86_400_000), durationMin: 60, capacity: 50, joinUrl: 'https://meet.darsly.app/demo' },
      });
      for (const st of cohort.slice(0, 4 + rand(4))) {
        await prisma.liveBooking.create({ data: { sessionId: session.id, studentId: st.id } }).catch(() => undefined);
      }
      stats.live++;
    }

    log(`${academy.name}: ${courses.length} courses · quizzes+assignments+attachments · live+chat`);
  }

  const [users, academies, coursesCount, enrolments, lessons] = await Promise.all([
    prisma.user.count(), prisma.academy.count(), prisma.course.count(), prisma.enrollment.count(), prisma.lesson.count(),
  ]);
  const summary = { users, academies, courses: coursesCount, lessons, enrolments, ...stats, password: DEMO_PASSWORD };
  log(`done — ${JSON.stringify(summary)}`);
  return summary;
}
