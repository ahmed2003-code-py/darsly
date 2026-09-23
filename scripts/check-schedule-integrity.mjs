#!/usr/bin/env node
/**
 * Read-only integrity report for scheduling scope (Architecture Reset,
 * Phase 5). Reports; never modifies. Exit 1 on anomalies, 0 when clean.
 *
 *   DATABASE_URL=postgresql://... node scripts/check-schedule-integrity.mjs
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
};

report(
  'GroupSession whose academy differs from its Group',
  await prisma.$queryRaw`SELECT s.id, s."academyId", g."academyId" AS group_academy FROM "GroupSession" s JOIN "Group" g ON g.id = s."groupId" WHERE s."academyId" <> g."academyId"`,
);
report(
  'GroupSession whose Room belongs to another academy',
  await prisma.$queryRaw`SELECT s.id, s."academyId", r."academyId" AS room_academy FROM "GroupSession" s JOIN "Room" r ON r.id = s."roomId" WHERE s."academyId" <> r."academyId"`,
);
report(
  'GroupSession with a dangling Group/Room/teacher reference',
  await prisma.$queryRaw`
  SELECT s.id FROM "GroupSession" s
  LEFT JOIN "Group" g ON g.id = s."groupId" LEFT JOIN "Room" r ON r.id = s."roomId" LEFT JOIN "User" u ON u.id = s."teacherUserId"
  WHERE g.id IS NULL OR (s."roomId" IS NOT NULL AND r.id IS NULL) OR (s."teacherUserId" IS NOT NULL AND u.id IS NULL)`,
);
report(
  'ONLINE GroupSession with a physical location or room',
  await prisma.$queryRaw`SELECT id FROM "GroupSession" WHERE mode = 'ONLINE' AND ("locationType" IS NOT NULL OR "roomId" IS NOT NULL)`,
);
report(
  'PHYSICAL/HYBRID GroupSession without a location type (new rows only; historical NULLs predate the rule)',
  await prisma.$queryRaw`SELECT id FROM "GroupSession" WHERE mode <> 'ONLINE' AND "locationType" IS NULL AND "createdAt" > '2026-09-22'`,
);
report(
  'GroupSession with a Room but a non-CENTER location',
  await prisma.$queryRaw`SELECT id FROM "GroupSession" WHERE "roomId" IS NOT NULL AND "locationType" IS DISTINCT FROM 'CENTER'`,
);
report(
  'Center GroupSession whose teacher is not a member of that Center',
  await prisma.$queryRaw`
  SELECT s.id, s."teacherUserId", s."academyId" FROM "GroupSession" s JOIN "Academy" a ON a.id = s."academyId" AND a.kind = 'CENTER'
  LEFT JOIN "AcademyMembership" m ON m."userId" = s."teacherUserId" AND m."academyId" = s."academyId" AND m."deletedAt" IS NULL
  WHERE s."teacherUserId" IS NOT NULL AND s.status = 'SCHEDULED' AND s."startAt" > now() AND m.id IS NULL`,
);
report(
  'LiveSession without academyId (migration gap)',
  await prisma.$queryRaw`SELECT id, "tenantId" FROM "LiveSession" WHERE "academyId" IS NULL`,
);
report(
  'LiveSession whose Group belongs to another academy',
  await prisma.$queryRaw`SELECT l.id, l."academyId", g."academyId" AS group_academy FROM "LiveSession" l JOIN "Group" g ON g.id = l."groupId" WHERE l."academyId" <> g."academyId"`,
);
report(
  'PERSONAL LiveSession whose academyId != tenantId',
  await prisma.$queryRaw`SELECT l.id FROM "LiveSession" l JOIN "Academy" a ON a.id = l."academyId" WHERE a.kind = 'PERSONAL' AND l."academyId" <> l."tenantId"`,
);
report(
  "LiveSession whose teacherUserId is not the author profile's user",
  await prisma.$queryRaw`SELECT l.id FROM "LiveSession" l JOIN "TeacherProfile" tp ON tp.id = l."tenantId" WHERE l."teacherUserId" IS NOT NULL AND l."teacherUserId" <> tp."userId"`,
);
report(
  'Center LiveSession whose teacher is not a member of that Center (future, scheduled)',
  await prisma.$queryRaw`
  SELECT l.id FROM "LiveSession" l JOIN "Academy" a ON a.id = l."academyId" AND a.kind = 'CENTER'
  LEFT JOIN "AcademyMembership" m ON m."userId" = l."teacherUserId" AND m."academyId" = l."academyId" AND m."deletedAt" IS NULL
  WHERE l."teacherUserId" IS NOT NULL AND l.status = 'SCHEDULED' AND l."startsAt" > now() AND m.id IS NULL`,
);
report(
  'AttendanceSession whose academy differs from its Group',
  await prisma.$queryRaw`SELECT s.id FROM "AttendanceSession" s JOIN "Group" g ON g.id = s."groupId" WHERE s."academyId" <> g."academyId"`,
);
report(
  'AttendanceRecord with a dangling session/student',
  await prisma.$queryRaw`SELECT r.id FROM "AttendanceRecord" r LEFT JOIN "AttendanceSession" s ON s.id = r."sessionId" LEFT JOIN "StudentProfile" p ON p.id = r."studentId" WHERE s.id IS NULL OR p.id IS NULL`,
);
const excl =
  await prisma.$queryRaw`SELECT conname FROM pg_constraint WHERE conname IN ('GroupSession_room_no_overlap','GroupSession_teacher_no_overlap','GroupSession_group_no_overlap') ORDER BY conname`;
if (excl.length !== 3) {
  findings.push('exclusion constraints');
  console.log('\nMissing exclusion constraints:', 3 - excl.length);
}

const totals =
  await prisma.$queryRaw`SELECT (SELECT count(*) FROM "GroupSession") AS group_sessions, (SELECT count(*) FROM "LiveSession") AS live_sessions, (SELECT count(*) FROM "AttendanceSession") AS attendance_sessions, (SELECT count(*) FROM "Room") AS rooms`;
console.log(
  '\nTotals:',
  JSON.stringify(totals[0], (k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  '| exclusion constraints:',
  excl.length,
);
await prisma.$disconnect();
if (findings.length) {
  console.log(`\n${findings.length} anomaly class(es) found. Nothing was modified.`);
  process.exit(1);
}
console.log('No schedule anomalies.');
