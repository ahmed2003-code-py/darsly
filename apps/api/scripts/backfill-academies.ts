/**
 * Phase-1 backfill: promote the implicit teacher-tenant into explicit Academy
 * workspaces WITHOUT changing any existing behaviour or moving any FK values.
 *
 * Identity-preserving: each Academy.id === the teacher's TeacherProfile.id, which
 * is exactly the value already stored in every `tenantId` column. So once later
 * phases rename tenantId → academyId, all foreign keys are already valid.
 *
 * Idempotent — safe to run repeatedly (dev, staging, prod). Run with:
 *   DATABASE_URL=... npx ts-node --transpile-only scripts/backfill-academies.ts
 */
import { PrismaClient, TeacherStatus, AcademyStatus } from '@prisma/client';

const prisma = new PrismaClient();

function mapStatus(s: TeacherStatus): AcademyStatus {
  switch (s) {
    case 'APPROVED': return 'ACTIVE';
    case 'PENDING': return 'PENDING';
    case 'SUSPENDED': return 'SUSPENDED';
    case 'REJECTED': return 'ARCHIVED';
    default: return 'PENDING';
  }
}

async function main() {
  const teachers = await prisma.teacherProfile.findMany({
    include: { user: { select: { fullName: true } } },
  });
  console.log(`→ ${teachers.length} teacher(s) → academies`);

  // 1) One Academy per teacher (id === TeacherProfile.id) + OWNER membership.
  for (const tp of teachers) {
    await prisma.academy.upsert({
      where: { id: tp.id },
      update: {}, // never clobber later manual edits on re-run
      create: {
        id: tp.id, // identity-preserving — matches existing tenantId values
        slug: tp.slug,
        name: tp.user.fullName?.trim() || tp.slug,
        status: mapStatus(tp.status),
        ownerUserId: tp.userId,
        language: tp.language ?? 'ar',
        maxConcurrentSessions: tp.maxConcurrentSessions ?? 2,
        requiresEnrollmentApproval: !tp.autoApproveEnrollments,
        // Preserve the current economics: today's commission % becomes the
        // additive platform service fee % (same magnitude of platform revenue).
        feeType: 'PERCENT',
        feeValue: tp.commissionPercent ?? 20,
      },
    });

    await prisma.academyMembership.upsert({
      where: { userId_academyId: { userId: tp.userId, academyId: tp.id } },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: { userId: tp.userId, academyId: tp.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
    });
  }

  // 2) STUDENT memberships from existing enrollments (tenantId === academyId).
  //    A membership is created once per (student-user, academy).
  const enrollments = await prisma.enrollment.findMany({
    select: { tenantId: true, createdAt: true, student: { select: { userId: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // earliest academy per student-user → Home Academy
  const homeByUser = new Map<string, string>();
  let studentMemberships = 0;
  for (const e of enrollments) {
    const userId = e.student.userId;
    const academyId = e.tenantId;
    if (!homeByUser.has(userId)) homeByUser.set(userId, academyId);

    const existing = await prisma.academyMembership.findUnique({
      where: { userId_academyId: { userId, academyId } },
    });
    if (existing) continue; // owner/teacher membership or already backfilled — leave it
    await prisma.academyMembership.create({
      data: { userId, academyId, role: 'STUDENT', status: 'ACTIVE', joinedAt: e.createdAt },
    });
    studentMemberships++;
  }

  // 3) Mark exactly one Home Academy per student-user (their earliest enrollment).
  let homesSet = 0;
  for (const [userId, academyId] of homeByUser) {
    const res = await prisma.academyMembership.updateMany({
      where: { userId, academyId, role: 'STUDENT', isHome: false },
      data: { isHome: true },
    });
    homesSet += res.count;
  }

  // Integrity report
  const [academies, owners, students, homes] = await Promise.all([
    prisma.academy.count(),
    prisma.academyMembership.count({ where: { role: 'OWNER' } }),
    prisma.academyMembership.count({ where: { role: 'STUDENT' } }),
    prisma.academyMembership.count({ where: { isHome: true } }),
  ]);
  console.log(`✓ academies=${academies} owners=${owners} students=${students} (new=${studentMemberships}) homes=${homes} (set=${homesSet})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('backfill failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
