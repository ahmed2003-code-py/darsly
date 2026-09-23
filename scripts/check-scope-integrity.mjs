#!/usr/bin/env node
/**
 * Read-only integrity report for organisation scope (Architecture Reset,
 * Phase 4). Reports; never modifies. Exit 1 on anomalies so it can gate a
 * rollout, exit 0 when clean.
 *
 *   DATABASE_URL=postgresql://... node scripts/check-scope-integrity.mjs
 */
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}
const prisma = new PrismaClient();
const findings = [];
const report = (kind, rows) => {
  if (!rows.length) return;
  findings.push(kind);
  console.log(`\n${kind} (${rows.length})`);
  for (const r of rows.slice(0, 25)) console.log('   ' + JSON.stringify(r));
  if (rows.length > 25) console.log(`   … ${rows.length - 25} more`);
};

report(
  'Course without academyId',
  await prisma.$queryRaw`SELECT id, "tenantId" FROM "Course" WHERE "academyId" IS NULL`,
);
report(
  'Course whose academyId is not an Academy',
  await prisma.$queryRaw`SELECT c.id, c."academyId" FROM "Course" c LEFT JOIN "Academy" a ON a.id = c."academyId" WHERE c."academyId" IS NOT NULL AND a.id IS NULL`,
);
report(
  'PERSONAL course where tenantId != academyId (would mean an author outside their own workspace)',
  await prisma.$queryRaw`SELECT c.id, c."tenantId", c."academyId" FROM "Course" c JOIN "Academy" a ON a.id = c."academyId" WHERE a.kind = 'PERSONAL' AND c."tenantId" <> c."academyId"`,
);
report(
  'CENTER course where tenantId == academyId (a Center is never an author)',
  await prisma.$queryRaw`SELECT c.id FROM "Course" c JOIN "Academy" a ON a.id = c."academyId" WHERE a.kind = 'CENTER' AND c."tenantId" = c."academyId"`,
);
report(
  'CENTER course with a price (must be 0 until the finance phase)',
  await prisma.$queryRaw`SELECT c.id, c."priceCents" FROM "Course" c JOIN "Academy" a ON a.id = c."academyId" WHERE a.kind = 'CENTER' AND c."priceCents" <> 0`,
);
report(
  'Course author who is not a member of the Center the course is offered in',
  await prisma.$queryRaw`
  SELECT c.id, c."tenantId", c."academyId" FROM "Course" c
  JOIN "Academy" a ON a.id = c."academyId" AND a.kind = 'CENTER'
  JOIN "TeacherProfile" tp ON tp.id = c."tenantId"
  LEFT JOIN "AcademyMembership" m ON m."userId" = tp."userId" AND m."academyId" = c."academyId" AND m."deletedAt" IS NULL
  WHERE m.id IS NULL`,
);
report(
  'Enrollment without academyId',
  await prisma.$queryRaw`SELECT id, "courseId" FROM "Enrollment" WHERE "academyId" IS NULL`,
);
report(
  'Enrollment whose academyId differs from its Course (crossed academies)',
  await prisma.$queryRaw`SELECT e.id, e."academyId", c."academyId" AS course_academy FROM "Enrollment" e JOIN "Course" c ON c.id = e."courseId" WHERE e."academyId" IS DISTINCT FROM c."academyId"`,
);
report(
  'Enrollment whose tenantId differs from its Course author',
  await prisma.$queryRaw`SELECT e.id FROM "Enrollment" e JOIN "Course" c ON c.id = e."courseId" WHERE e."tenantId" <> c."tenantId"`,
);
report(
  'Payment without academyId',
  await prisma.$queryRaw`SELECT id, "courseId" FROM "Payment" WHERE "academyId" IS NULL`,
);
report(
  'Payment whose academyId differs from its Course (crossed academies)',
  await prisma.$queryRaw`SELECT p.id, p."academyId", c."academyId" AS course_academy FROM "Payment" p JOIN "Course" c ON c.id = p."courseId" WHERE p."academyId" IS DISTINCT FROM c."academyId"`,
);
report(
  'Payment on a CENTER course (no money may enter a Center yet)',
  await prisma.$queryRaw`SELECT p.id, p."courseId" FROM "Payment" p JOIN "Academy" a ON a.id = p."academyId" WHERE a.kind = 'CENTER'`,
);
report(
  'AcademySubject pointing at a missing master Subject',
  await prisma.$queryRaw`SELECT s.id FROM "AcademySubject" s LEFT JOIN "Subject" x ON x.id = s."subjectId" WHERE x.id IS NULL`,
);
report(
  'AcademySubject on a PERSONAL academy (activation is a Center concept)',
  await prisma.$queryRaw`SELECT s.id, s."academyId" FROM "AcademySubject" s JOIN "Academy" a ON a.id = s."academyId" WHERE a.kind <> 'CENTER'`,
);

const totals =
  await prisma.$queryRaw`SELECT (SELECT count(*) FROM "Course") AS courses, (SELECT count(*) FROM "Enrollment") AS enrollments, (SELECT count(*) FROM "Payment") AS payments, (SELECT count(*) FROM "AcademySubject") AS academy_subjects`;
console.log(
  '\nTotals:',
  JSON.stringify(totals[0], (k, v) => (typeof v === 'bigint' ? Number(v) : v)),
);
await prisma.$disconnect();
if (findings.length) {
  console.log(`\n${findings.length} anomaly class(es) found. Nothing was modified.`);
  process.exit(1);
}
console.log('No scope anomalies.');
