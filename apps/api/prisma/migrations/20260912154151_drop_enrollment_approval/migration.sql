-- Enrolment approval is gone: a free course lets the student in on the spot,
-- and a paid one waits only for the money to be confirmed. The status that used
-- to mean both is renamed to say the one thing it still means.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EnrollmentStatus' AND e.enumlabel = 'PENDING_APPROVAL'
  ) THEN
    ALTER TYPE "EnrollmentStatus" RENAME VALUE 'PENDING_APPROVAL' TO 'PENDING_PAYMENT';
  END IF;
END $$;

-- Nothing may grant access by omission, so the column has no default any more.
ALTER TABLE "Enrollment" ALTER COLUMN "status" DROP DEFAULT;

-- Anyone still sitting in a teacher's queue with nothing left to pay is let in,
-- rather than waiting for a decision no screen will ever ask for again.
UPDATE "Enrollment" e
SET "status" = 'ACTIVE', "approvedAt" = COALESCE(e."approvedAt", NOW())
WHERE e."status" = 'PENDING_PAYMENT'
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."enrollmentId" = e.id AND p."status" = 'PENDING');

ALTER TABLE "Course" DROP COLUMN IF EXISTS "requiresEnrollmentApproval";
ALTER TABLE "Academy" DROP COLUMN IF EXISTS "requiresEnrollmentApproval";
ALTER TABLE "TeacherProfile" DROP COLUMN IF EXISTS "autoApproveEnrollments";
