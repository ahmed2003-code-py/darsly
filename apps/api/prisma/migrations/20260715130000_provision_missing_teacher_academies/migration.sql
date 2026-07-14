-- Heal teachers registered AFTER the original academy backfill: signup/approval
-- never created their Academy + OWNER membership, so every @AcademyStaff console
-- route (courses, lessons, quizzes, wallet…) returned 404 "Academy not found".
-- Same identity-preserving inserts as 20260713130000, re-run idempotently
-- (ON CONFLICT DO NOTHING) so already-provisioned teachers are untouched.

-- 1) One Academy per teacher missing one (id === TeacherProfile.id).
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

-- 2) OWNER membership for each teacher missing one.
INSERT INTO "AcademyMembership"(id, "userId", "academyId", role, status, "isHome", "joinedAt", "updatedAt")
SELECT 'own_' || tp.id, tp."userId", tp.id, 'OWNER'::"AcademyRole", 'ACTIVE'::"MembershipStatus", false, now(), now()
FROM "TeacherProfile" tp
ON CONFLICT ("userId", "academyId") DO NOTHING;
