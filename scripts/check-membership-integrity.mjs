#!/usr/bin/env node
/**
 * Read-only integrity report for AcademyMembership rows that the hardened
 * identity rules (Architecture Reset, Phase 1) would now refuse to create.
 * Reports; never modifies. Exit 1 when anomalies exist so it can gate a
 * rollout, exit 0 when clean.
 *
 *   DATABASE_URL=postgresql://... node scripts/check-membership-integrity.mjs
 */
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const prisma = new PrismaClient();

const findings = [];
const report = (kind, rows) => {
  if (!rows.length) return;
  findings.push(kind);
  console.log(`\n${kind} (${rows.length})`);
  for (const r of rows) console.log(`   membership=${r.id} user=${r.userId} academy=${r.academyId} role=${r.role} status=${r.status}`);
};

const base = { deletedAt: null, status: { in: ['INVITED', 'ACTIVE', 'SUSPENDED'] } };
const sel = { id: true, userId: true, academyId: true, role: true, status: true };

// 1) Staff role held by a learner identity.
report('STUDENT identity holding a staff membership (OWNER/TEACHER/ASSISTANT)', await prisma.academyMembership.findMany({
  where: { ...base, role: { in: ['OWNER', 'TEACHER', 'ASSISTANT'] }, user: { role: 'STUDENT' } }, select: sel,
}));

// 2) TEACHER/ASSISTANT membership without an approved TeacherProfile.
report('TEACHER/ASSISTANT membership whose user is not an APPROVED teacher', await prisma.academyMembership.findMany({
  where: {
    ...base, role: { in: ['TEACHER', 'ASSISTANT'] },
    OR: [{ user: { role: { not: 'TEACHER' } } }, { user: { teacherProfile: null } }, { user: { teacherProfile: { status: { not: 'APPROVED' } } } }],
  }, select: sel,
}));

// 3) ACTIVE membership on a disabled account (would now be refused a context).
report('ACTIVE membership on an inactive user', await prisma.academyMembership.findMany({
  where: { deletedAt: null, status: 'ACTIVE', user: { isActive: false } }, select: sel,
}));

// 4) Soft-deleted row still marked ACTIVE (previously granted via findUnique).
report('Soft-deleted membership still ACTIVE', await prisma.academyMembership.findMany({
  where: { deletedAt: { not: null }, status: 'ACTIVE' }, select: sel,
}));

// 5) Orphaned per-group scope: assignments/sessions for a member who is no longer ACTIVE.
const stale = await prisma.$queryRaw`
  SELECT ga."id", ga."userId", ga."academyId", 'ASSIGNMENT' AS role, m."status"
  FROM "GroupAssignment" ga
  JOIN "AcademyMembership" m ON m."userId" = ga."userId" AND m."academyId" = ga."academyId"
  WHERE ga."deletedAt" IS NULL AND m."status" <> 'ACTIVE'`;
report('GroupAssignment retained by a non-ACTIVE member', stale);

await prisma.$disconnect();
if (findings.length) { console.log(`\n${findings.length} anomaly class(es) found. Nothing was modified.`); process.exit(1); }
console.log('No membership anomalies.');
