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
  WHERE m."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."studentId" = m."studentId" AND e."academyId" = m."academyId" AND e."deletedAt" IS NULL)
  -- C1: a learner on the center's register belongs to its groups without a course.
  AND NOT EXISTS (SELECT 1 FROM "AcademyStudent" a WHERE a."academyId" = m."academyId" AND a."studentId" = m."studentId")`,
);
report(
  'GroupAssignment whose academy differs from its Group',
  await prisma.$queryRaw`SELECT ga.id, ga."academyId", g."academyId" AS group_academy FROM "GroupAssignment" ga JOIN "Group" g ON g.id = ga."groupId" WHERE ga."academyId" <> g."academyId"`,
);
report(
  'GroupAssignment held by a STUDENT identity, or a STAFF identity assigned as a TEACHER',
  // A STAFF identity may be a group's ASSISTANT (C2/C6 group-scoped work).
  await prisma.$queryRaw`SELECT ga.id, u.role, ga.role AS as_role FROM "GroupAssignment" ga JOIN "User" u ON u.id = ga."userId" WHERE ga."deletedAt" IS NULL AND (u.role = 'STUDENT' OR (u.role = 'STAFF' AND ga.role::text <> 'ASSISTANT'))`,
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
  WHERE r."deletedAt" IS NULL
    -- C2: a makeup visitor (homeGroupId) belongs to another group by design.
    AND r."homeGroupId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "GroupMembership" m WHERE m."groupId" = s."groupId" AND m."studentId" = r."studentId")`,
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
  SELECT a.id, a."ownerUserId" FROM "Academy" a WHERE a.kind = 'CENTER' AND a."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "AcademyMembership" m WHERE m."academyId" = a.id AND m."userId" = a."ownerUserId" AND m.role = 'OWNER' AND m."deletedAt" IS NULL)`,
);

// ── Center Operations C1–C8 ────────────────────────────────────────────────
report(
  'AcademyStudent whose StudentProfile is missing (orphan register record)',
  await prisma.$queryRaw`SELECT s.id FROM "AcademyStudent" s LEFT JOIN "StudentProfile" p ON p.id = s."studentId" WHERE p.id IS NULL`,
);
report(
  'GroupMembership whose academy differs from its Group',
  await prisma.$queryRaw`SELECT m.id FROM "GroupMembership" m JOIN "Group" g ON g.id = m."groupId" WHERE m."academyId" <> g."academyId"`,
);
report(
  'More than one active QR card for one learner (C3)',
  await prisma.$queryRaw`SELECT "academyStudentId", count(*)::int n FROM "AcademyStudentCard" WHERE "revokedAt" IS NULL GROUP BY 1 HAVING count(*) > 1`,
);
report(
  'GuardianLink to a learner with no register record and no enrollment in that academy (cross-tenant)',
  await prisma.$queryRaw`
  SELECT l.id FROM "GuardianLink" l WHERE l.status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM "AcademyStudent" s WHERE s."academyId" = l."academyId" AND s."studentId" = l."studentId")
  AND NOT EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."academyId" = l."academyId" AND e."studentId" = l."studentId")`,
);
report(
  "C4: a collection's allocations do not add up to it",
  await prisma.$queryRaw`SELECT k.id FROM "CenterCollection" k LEFT JOIN (SELECT "collectionId", sum("amountCents") s FROM "CenterAllocation" GROUP BY 1) a ON a."collectionId" = k.id WHERE coalesce(a.s, 0) <> k."amountCents"`,
);
report(
  'C4: a charge allocated beyond its amount (live collections)',
  await prisma.$queryRaw`
  SELECT c.id FROM "CenterCharge" c JOIN (SELECT a."chargeId", sum(a."amountCents") s FROM "CenterAllocation" a JOIN "CenterCollection" k ON k.id = a."collectionId" AND k."reversedAt" IS NULL GROUP BY 1) x ON x."chargeId" = c.id
  WHERE x.s > c."amountCents"`,
);
report(
  'C4: an allocation crossing academies or learners',
  await prisma.$queryRaw`SELECT a.id FROM "CenterAllocation" a JOIN "CenterCollection" k ON k.id = a."collectionId" JOIN "CenterCharge" c ON c.id = a."chargeId" WHERE k."academyId" <> c."academyId" OR k."academyStudentId" <> c."academyStudentId"`,
);
report(
  'C5: more than one OPEN follow-up case for one learner, reason and signal',
  await prisma.$queryRaw`SELECT "academyStudentId", reason, "signalKey" FROM "StudentFollowUp" WHERE status = 'OPEN' AND "signalKey" IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1`,
);
report(
  'C6: a paper result crossing academies with its exam',
  await prisma.$queryRaw`SELECT r.id FROM "PaperExamResult" r JOIN "PaperExam" e ON e.id = r."examId" WHERE r."academyId" <> e."academyId"`,
);
report(
  'C7: day-close versions not consecutive',
  await prisma.$queryRaw`SELECT "academyId", "businessDate" FROM "CenterDayClose" GROUP BY 1, 2 HAVING max(version) <> count(*)`,
);
report(
  'C8: overlapping teacher agreements of one method (dates and groups)',
  await prisma.$queryRaw`
  SELECT a.id, b.id AS other FROM "TeacherAgreement" a JOIN "TeacherAgreement" b
    ON b."academyId" = a."academyId" AND b."teacherUserId" = a."teacherUserId" AND b.method = a.method AND b.id > a.id
  WHERE daterange(a."effectiveFrom", a."effectiveTo", '[]') && daterange(b."effectiveFrom", b."effectiveTo", '[]')
    AND (cardinality(a."groupIds") = 0 OR cardinality(b."groupIds") = 0 OR a."groupIds" && b."groupIds")`,
);
report(
  'C8: a settlement whose recorded payments or adjustments do not match its totals, or paid beyond payable',
  await prisma.$queryRaw`
  SELECT s.id FROM "TeacherSettlement" s
  WHERE s."paidCents" <> coalesce((SELECT sum("amountCents") FROM "TeacherSettlementPayment" p WHERE p."settlementId" = s.id), 0)
     OR s."adjustCents" <> coalesce((SELECT sum("amountCents") FROM "TeacherSettlementAdjustment" j WHERE j."settlementId" = s.id), 0)
     OR s."grossCents" <> coalesce((SELECT sum("amountCents") FROM "TeacherSettlementLine" l WHERE l."settlementId" = s.id), 0)
     OR s."paidCents" > s."grossCents" + s."adjustCents"`,
);
report(
  'C8: one source paid twice to one teacher (live settlements)',
  await prisma.$queryRaw`SELECT "teacherUserId", kind, "sourceId" FROM "TeacherSettlementLine" WHERE NOT voided GROUP BY 1, 2, 3 HAVING count(*) > 1`,
);
report(
  'C8: a settlement line crossing academies or teachers with its settlement',
  await prisma.$queryRaw`SELECT l.id FROM "TeacherSettlementLine" l JOIN "TeacherSettlement" s ON s.id = l."settlementId" WHERE l."academyId" <> s."academyId" OR l."teacherUserId" <> s."teacherUserId"`,
);

// AuditLog.academyId deliberately has no FK: audit history must outlive the
// academy it describes, so a row pointing at a deleted Center is not an anomaly.

await prisma.$disconnect();
if (findings.length) {
  console.log(`\n${findings.length} anomaly kind(s).`);
  process.exit(1);
}
console.log('Center operations integrity: clean.');
