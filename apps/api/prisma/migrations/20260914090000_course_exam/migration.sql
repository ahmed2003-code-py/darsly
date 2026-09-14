-- One exam and one assignment for the whole course, instead of one of each per
-- lesson.
--
-- The lesson stays the container — everything that grants access, records
-- completion, awards points and issues certificates is keyed on a lesson, and
-- moving the quiz off it would touch all of that. What changes is that the
-- course now names which lesson is *the* exam and which is *the* assignment.
-- Being a single column is what makes it one of each.
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "examLessonId" TEXT;
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "assignmentLessonId" TEXT;

-- A lesson belongs to one course, so pointing at it from two courses is a bug.
CREATE UNIQUE INDEX IF NOT EXISTS "Course_examLessonId_key" ON "Course"("examLessonId");
CREATE UNIQUE INDEX IF NOT EXISTS "Course_assignmentLessonId_key" ON "Course"("assignmentLessonId");

DO $$ BEGIN
  ALTER TABLE "Course" ADD CONSTRAINT "Course_examLessonId_fkey"
    FOREIGN KEY ("examLessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Course" ADD CONSTRAINT "Course_assignmentLessonId_fkey"
    FOREIGN KEY ("assignmentLessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What to watch when the exam says you are not ready. A lesson in the same
-- course, so it plays through the protected pipeline like any other.
ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "remedialLessonId" TEXT;

DO $$ BEGIN
  ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_remedialLessonId_fkey"
    FOREIGN KEY ("remedialLessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A course that already has exactly one quiz lesson keeps it, as its exam.
-- Anything more ambiguous is left for the teacher to name, because guessing
-- which of three is "the" exam would gate a course on the wrong paper.
UPDATE "Course" c
   SET "examLessonId" = sole.id
  FROM (
    SELECT u."courseId" AS course_id, MIN(l.id) AS id, COUNT(*) AS n
      FROM "Lesson" l
      JOIN "CourseUnit" u ON u.id = l."unitId"
     WHERE l.type = 'QUIZ' AND l."deletedAt" IS NULL
     GROUP BY u."courseId"
  ) sole
 WHERE sole.course_id = c.id
   AND sole.n = 1
   AND c."examLessonId" IS NULL;

UPDATE "Course" c
   SET "assignmentLessonId" = sole.id
  FROM (
    SELECT u."courseId" AS course_id, MIN(l.id) AS id, COUNT(*) AS n
      FROM "Lesson" l
      JOIN "CourseUnit" u ON u.id = l."unitId"
     WHERE l.type = 'ASSIGNMENT' AND l."deletedAt" IS NULL
     GROUP BY u."courseId"
  ) sole
 WHERE sole.course_id = c.id
   AND sole.n = 1
   AND c."assignmentLessonId" IS NULL;
