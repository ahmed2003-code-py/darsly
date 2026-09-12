-- A course is offered to exact years now, not to a whole band. "Second
-- baccalaureate" should reach second-baccalaureate students and nobody else;
-- the band was too coarse to do that, so every secondary student saw every
-- secondary course.
CREATE TABLE IF NOT EXISTS "CourseGrade" (
  "courseId" TEXT NOT NULL,
  "gradeId"  TEXT NOT NULL,
  CONSTRAINT "CourseGrade_pkey" PRIMARY KEY ("courseId", "gradeId")
);
CREATE INDEX IF NOT EXISTS "CourseGrade_gradeId_idx" ON "CourseGrade"("gradeId");

DO $$
BEGIN
  ALTER TABLE "CourseGrade" ADD CONSTRAINT "CourseGrade_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER TABLE "CourseGrade" ADD CONSTRAINT "CourseGrade_gradeId_fkey"
    FOREIGN KEY ("gradeId") REFERENCES "GradeLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A course that already named one year keeps exactly that year.
INSERT INTO "CourseGrade" ("courseId", "gradeId")
SELECT c.id, c."gradeId" FROM "Course" c WHERE c."gradeId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- One that named only a band takes every year in it, which is what it meant.
INSERT INTO "CourseGrade" ("courseId", "gradeId")
SELECT c.id, g.id
FROM "Course" c
JOIN "GradeLevel" g ON g."stage" = ANY(c."stages")
WHERE c."gradeId" IS NULL AND cardinality(c."stages") > 0
ON CONFLICT DO NOTHING;

ALTER TABLE "Course" DROP COLUMN IF EXISTS "stages";
ALTER TABLE "Course" DROP COLUMN IF EXISTS "gradeId";
