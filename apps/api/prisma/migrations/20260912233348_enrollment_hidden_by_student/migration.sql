-- A student can take a dead enrolment off their own shelf. Additive and
-- guarded; the row itself is never deleted, because it is the record that
-- money changed hands.
ALTER TABLE "Enrollment" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);
