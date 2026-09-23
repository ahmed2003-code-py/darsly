/**
 * Verify a cleanup through the SAME layer the app uses — PrismaService, with
 * the soft-delete middleware attached. Counting with a bare PrismaClient would
 * show the rows that are still physically there and prove nothing about what a
 * user can actually see.
 */
import { PrismaService } from '../src/prisma/prisma.service';

const KEEP = process.env.KEEP_TEACHER ?? 'amr927@gmail.com';

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  await prisma.onModuleInit(); // attaches the soft-delete middleware

  console.log('── what the application can still see ──');
  console.log({
    users: await prisma.user.count(),
    teacherProfiles: await prisma.teacherProfile.count(),
    studentProfiles: await prisma.studentProfile.count(),
    academies: await prisma.academy.count(),
    courses: await prisma.course.count(),
    publishedCourses: await prisma.course.count({ where: { status: 'PUBLISHED' } }),
    lessons: await prisma.lesson.count(),
    enrollments: await prisma.enrollment.count(),
    payments: await prisma.payment.count(),
    ledgerEntries: await prisma.ledgerEntry.count(),
    invoices: await prisma.invoice.count(),
    reviews: await prisma.review.count(),
    certificates: await prisma.certificate.count(),
    academySites: await prisma.academySite.count(),
    memberships: await prisma.academyMembership.count(),
  });

  const survivors = await prisma.user.findMany({ select: { email: true, role: true } });
  console.log(
    '\nsurviving accounts:',
    survivors.map((u) => `${u.email} (${u.role})`),
  );

  const kept = await prisma.user.findFirst({
    where: { email: KEEP },
    include: { teacherProfile: true },
  });
  console.log('\nkept teacher still intact:', !!kept?.teacherProfile);
  if (kept?.teacherProfile) {
    const tid = kept.teacherProfile.id;
    console.log('their academy still has:', {
      courses: await prisma.course.count({ where: { tenantId: tid } }),
      published: await prisma.course.count({ where: { tenantId: tid, status: 'PUBLISHED' } }),
      lessons: await prisma.lesson.count({ where: { unit: { course: { tenantId: tid } } } }),
      site: await prisma.academySite.count({ where: { academyId: tid } }),
      media: await prisma.academyMedia.count({ where: { academyId: tid } }),
      facts: await prisma.academyProfileFacts.count({ where: { academyId: tid } }),
    });
  }

  // The money the admin console reports must now be zero.
  const paid = await prisma.payment.aggregate({
    where: { status: 'PAID' },
    _sum: { amountCents: true },
  });
  const credits = await prisma.ledgerEntry.aggregate({
    where: { direction: 'CREDIT' },
    _sum: { amountCents: true },
  });
  console.log('\nvisible money:', {
    paidPiasters: paid._sum.amountCents ?? 0,
    ledgerCredits: credits._sum.amountCents ?? 0,
  });

  // And nothing was actually destroyed.
  const raw: any[] = await prisma.$queryRaw`
    SELECT
      (SELECT count(*) FROM "User")::int AS users,
      (SELECT count(*) FROM "Payment")::int AS payments,
      (SELECT count(*) FROM "Course")::int AS courses`;
  console.log('still physically present (recoverable):', raw[0]);

  await prisma.$disconnect();
})();
