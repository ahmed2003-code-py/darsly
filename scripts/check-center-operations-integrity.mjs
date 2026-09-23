#!/usr/bin/env node
/**
 * Read-only integrity report for Center operations (Architecture Reset,
 * Phase 6): groups, group members, attendance, rooms, subjects, staff and
 * audit rows all keyed on one organisation. Complements check-scope-integrity
 * (courses/enrollments/payments/subjects), check-schedule-integrity
 * (sessions) and check-membership-integrity (memberships) — it does not
 * repeat them. Reports; never modifies. Exit 1 on anomalies, 0 when clean.
 *
 *   DATABASE_URL=postgresql://... node scripts/check-center-operations-integrity.mjs
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

// Groups and their members belong to exactly one organisation.
report(
  'Group whose academyId is not an Academy',
  await prisma.$queryRaw`SELECT g.id, g."academyId" FROM "Group" g LEFT JOIN "Academy" a ON a.id = g."academyId" WHERE a.id IS NULL`,
);
report(
  'GroupMembership whose academy differs from its Group',
  await prisma.$queryRaw`SELECT m.id, m."academyId", g."academyId" AS group_academy FROM "GroupMembership" m JOIN "Group" g ON g.id = m."groupId" WHERE m."academyId" <> g."academyId"`,
);
report(
  'GroupMembership for a student with no Enrollment in that academy (organisation scope, not author scope)',
  await prisma.$queryRaw`
  SELECT m.id, m."studentId", m."academyId" FROM "GroupMembership" m
  WHERE m."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = m."studentId" AND e."academyId" = m."academyId" AND e."deletedAt" IS NULL)`,
);
report(
  'GroupAssignment whose academy differs from its Group',
  await prisma.$queryRaw`SELECT ga.id, ga."academyId", g."academyId" AS group_academy FROM "GroupAssignment" ga JOIN "Group" g ON g.id = ga."groupId" WHERE ga."academyId" <> g."academyId"`,
);
report(
  'GroupAssignment held by a STUDENT identity or a STAFF (non-teaching) identity',
  await prisma.$queryRaw`SELECT ga.id, u.role FROM "GroupAssignment" ga JOIN "User" u ON u.id = ga."userId" WHERE u.role IN ('STUDENT', 'STAFF')`,
);

// Attendance: session, record and group all in one organisation.
report(
  'AttendanceSession whose academy differs from its Group',
  await prisma.$queryRaw`SELECT s.id, s."academyId", g."academyId" AS group_academy FROM "AttendanceSession" s JOIN "Group" g ON g.id = s."groupId" WHERE s."academyId" <> g."academyId"`,
);
report(
  'AttendanceRecord whose academy differs from its AttendanceSession',
  await prisma.$queryRaw`SELECT r.id, r."academyId", s."academyId" AS session_academy FROM "AttendanceRecord" r JOIN "AttendanceSession" s ON s.id = r."sessionId" WHERE r."academyId" <> s."academyId"`,
);
report(
  'AttendanceRecord for a student outside that group',
  await prisma.$queryRaw`
  SELECT r.id, r."studentId" FROM "AttendanceRecord" r JOIN "AttendanceSession" s ON s.id = r."sessionId"
  WHERE r."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "GroupMembership" m WHERE m."groupId" = s."groupId" AND m."studentId" = r."studentId")`,
);

// Rooms are a Center's physical resource.
report(
  'Room whose academyId is not an Academy',
  await prisma.$queryRaw`SELECT r.id, r."academyId" FROM "Room" r LEFT JOIN "Academy" a ON a.id = r."academyId" WHERE a.id IS NULL`,
);

// Staff identity: a STAFF user never authors, never learns, owns at most one Center.
report(
  'STAFF identity with a TeacherProfile or StudentProfile',
  await prisma.$queryRaw`
  SELECT u.id FROM "User" u WHERE u.role = 'STAFF' AND (EXISTS (SELECT 1 FROM "TeacherProfile" t WHERE t."userId" = u.id) OR EXISTS (SELECT 1 FROM "StudentProfile" s WHERE s."userId" = u.id))`,
);
report(
  "STAFF identity authoring a Course (tenantId must never be a STAFF user's)",
  await prisma.$queryRaw`SELECT c.id FROM "Course" c JOIN "TeacherProfile" t ON t.id = c."tenantId" JOIN "User" u ON u.id = t."userId" WHERE u.role = 'STAFF'`,
);
report(
  'STAFF identity owning a PERSONAL academy or more than one Center',
  await prisma.$queryRaw`
  SELECT u.id, COUNT(a.id) AS owned, BOOL_OR(a.kind = 'PERSONAL') AS owns_personal FROM "User" u JOIN "Academy" a ON a."ownerUserId" = u.id
  WHERE u.role = 'STAFF' GROUP BY u.id HAVING COUNT(a.id) > 1 OR BOOL_OR(a.kind = 'PERSONAL')`,
);
report(
  'Center owner without an OWNER membership of that Center',
  await prisma.$queryRaw`
  SELECT a.id, a."ownerUserId" FROM "Academy" a WHERE a.kind = 'CENTER'
  AND NOT EXISTS (SELECT 1 FROM "AcademyMembership" m WHERE m."academyId" = a.id AND m."userId" = a."ownerUserId" AND m.role = 'OWNER' AND m."deletedAt" IS NULL)`,
);

// AuditLog.academyId deliberately has no FK: audit history must outlive the
// academy it describes, so a row pointing at a deleted Center is not an anomaly.

await prisma.$disconnect();
if (findings.length) {
  console.log(`\n${findings.length} anomaly kind(s).`);
  process.exit(1);
}
console.log('Center operations integrity: clean.');
