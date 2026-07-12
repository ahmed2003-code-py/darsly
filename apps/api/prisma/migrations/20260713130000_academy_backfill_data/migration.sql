-- Data migration: identity-preserving Academy backfill (runs automatically on
-- deploy so production is populated with zero manual steps). Fully idempotent —
-- deterministic ids + ON CONFLICT DO NOTHING make re-runs a no-op. Mirrors
-- scripts/backfill-academies.ts (kept for manual/testing use).

-- 1) One Academy per teacher, id === TeacherProfile.id (== existing tenantId values).
INSERT INTO "Academy"(
  id, slug, name, status, "ownerUserId", language,
  "maxConcurrentSessions", "requiresEnrollmentApproval", "feeType", "feeValue",
  "createdAt", "updatedAt"
)
SELECT
  tp.id,
  tp.slug,
  COALESCE(NULLIF(trim(u."fullName"), ''), tp.slug),
  CASE tp.status
    WHEN 'APPROVED' THEN 'ACTIVE'::"AcademyStatus"
    WHEN 'PENDING' THEN 'PENDING'::"AcademyStatus"
    WHEN 'SUSPENDED' THEN 'SUSPENDED'::"AcademyStatus"
    ELSE 'ARCHIVED'::"AcademyStatus"
  END,
  tp."userId",
  tp.language,
  tp."maxConcurrentSessions",
  (NOT tp."autoApproveEnrollments"),
  'PERCENT'::"FeeType",
  tp."commissionPercent",
  now(), now()
FROM "TeacherProfile" tp
JOIN "User" u ON u.id = tp."userId"
ON CONFLICT (id) DO NOTHING;

-- 2) OWNER membership for each teacher (deterministic id → idempotent).
INSERT INTO "AcademyMembership"(id, "userId", "academyId", role, status, "isHome", "joinedAt", "updatedAt")
SELECT 'own_' || tp.id, tp."userId", tp.id, 'OWNER'::"AcademyRole", 'ACTIVE'::"MembershipStatus", false, now(), now()
FROM "TeacherProfile" tp
ON CONFLICT ("userId", "academyId") DO NOTHING;

-- 3) STUDENT memberships from existing enrollments (tenantId === academyId).
INSERT INTO "AcademyMembership"(id, "userId", "academyId", role, status, "isHome", "joinedAt", "updatedAt")
SELECT DISTINCT ON (sp."userId", e."tenantId")
  'stu_' || sp."userId" || '_' || e."tenantId",
  sp."userId", e."tenantId", 'STUDENT'::"AcademyRole", 'ACTIVE'::"MembershipStatus", false, e."createdAt", now()
FROM "Enrollment" e
JOIN "StudentProfile" sp ON sp.id = e."studentId"
ON CONFLICT ("userId", "academyId") DO NOTHING;

-- 4) Home Academy = the academy of each student's earliest enrollment (one per user).
WITH firsts AS (
  SELECT DISTINCT ON (sp."userId") sp."userId" AS uid, e."tenantId" AS aid
  FROM "Enrollment" e
  JOIN "StudentProfile" sp ON sp.id = e."studentId"
  ORDER BY sp."userId", e."createdAt" ASC
)
UPDATE "AcademyMembership" m
SET "isHome" = true
FROM firsts f
WHERE m."userId" = f.uid AND m."academyId" = f.aid AND m.role = 'STUDENT'
  AND NOT EXISTS (SELECT 1 FROM "AcademyMembership" h WHERE h."userId" = f.uid AND h."isHome" = true);
