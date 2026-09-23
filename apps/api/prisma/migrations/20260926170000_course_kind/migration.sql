-- What a course is for, so its builder can look like it.
--
-- Additive and defaulted: every course that exists is STANDARD, which is what
-- every course that exists is. Nothing about enrolment, pricing, publishing or
-- the exam engine reads this column — only the teacher's editing screen does.

DO $$ BEGIN
  CREATE TYPE "CourseKind" AS ENUM ('STANDARD', 'EXAM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "kind" "CourseKind" NOT NULL DEFAULT 'STANDARD';

-- A course the Exam Creation Studio already made: its only lesson is the exam
-- it named. Backfilled so the handful created before this migration get the
-- screen they should have had.
UPDATE "Course" c
   SET "kind" = 'EXAM'
 WHERE c."examLessonId" IS NOT NULL
   AND c."deletedAt" IS NULL
   AND (
     SELECT COUNT(*)
       FROM "Lesson" l
       JOIN "CourseUnit" u ON u."id" = l."unitId"
      WHERE u."courseId" = c."id" AND l."deletedAt" IS NULL AND u."deletedAt" IS NULL
   ) = 1;
