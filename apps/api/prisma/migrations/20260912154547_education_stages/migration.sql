-- Teachers sign up saying which bands they teach, and a course is offered to
-- bands rather than to a single year. A student still picks their own year;
-- GradeLevel.stage is what joins the two back together.
DO $$
BEGIN
  CREATE TYPE "EducationStage" AS ENUM ('PRIMARY', 'PREPARATORY', 'SECONDARY', 'BACCALAUREATE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "GradeLevel"     ADD COLUMN IF NOT EXISTS "stage"  "EducationStage";
ALTER TABLE "TeacherProfile" ADD COLUMN IF NOT EXISTS "stages" "EducationStage"[] NOT NULL DEFAULT ARRAY[]::"EducationStage"[];
ALTER TABLE "Course"         ADD COLUMN IF NOT EXISTS "stages" "EducationStage"[] NOT NULL DEFAULT ARRAY[]::"EducationStage"[];

-- Existing years carry a code like "prep-3" / "sec-1"; read the band off it so
-- nobody has to re-enter what the data already says.
UPDATE "GradeLevel" SET "stage" = 'PRIMARY'       WHERE "stage" IS NULL AND "code" LIKE 'prim%';
UPDATE "GradeLevel" SET "stage" = 'PREPARATORY'   WHERE "stage" IS NULL AND "code" LIKE 'prep%';
UPDATE "GradeLevel" SET "stage" = 'SECONDARY'     WHERE "stage" IS NULL AND "code" LIKE 'sec%';
UPDATE "GradeLevel" SET "stage" = 'BACCALAUREATE' WHERE "stage" IS NULL AND "code" LIKE 'bacc%';

-- A course already aimed at one year is aimed at that year's band.
UPDATE "Course" c
SET "stages" = ARRAY[g."stage"]
FROM "GradeLevel" g
WHERE c."gradeId" = g.id AND g."stage" IS NOT NULL AND cardinality(c."stages") = 0;

-- A teacher's bands are the bands of the years they had listed.
UPDATE "TeacherProfile" tp
SET "stages" = sub.stages
FROM (
  SELECT tg."tenantId", ARRAY_AGG(DISTINCT g."stage") AS stages
  FROM "TeacherGrade" tg JOIN "GradeLevel" g ON g.id = tg."gradeId"
  WHERE g."stage" IS NOT NULL
  GROUP BY tg."tenantId"
) sub
WHERE tp.id = sub."tenantId" AND cardinality(tp."stages") = 0;
