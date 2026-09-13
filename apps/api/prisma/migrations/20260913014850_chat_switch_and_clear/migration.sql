-- A teacher can close messaging entirely, and either side can clear a
-- conversation off their own list. Additive and guarded.
ALTER TABLE "TeacherProfile"
  ADD COLUMN IF NOT EXISTS "acceptsStudentMessages" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "hiddenForTeacherAt" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "hiddenForStudentAt" TIMESTAMP(3);
