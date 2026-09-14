-- A question may have more than one right answer, and the teacher decides how
-- many the student is allowed to pick.
--
-- `correctOptionId` stays and keeps being written with the first of them, so a
-- deploy that lands between the migration and the new code still grades single
-- answers correctly. The array is the one that is read.
ALTER TABLE "QuizQuestion"
  ADD COLUMN IF NOT EXISTS "correctOptionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "QuizQuestion"
  ADD COLUMN IF NOT EXISTS "maxSelections" INTEGER NOT NULL DEFAULT 1;

-- Everything written before this had exactly one right answer.
UPDATE "QuizQuestion"
   SET "correctOptionIds" = ARRAY["correctOptionId"]
 WHERE "correctOptionId" IS NOT NULL
   AND cardinality("correctOptionIds") = 0;

-- The model answer a teacher writes for an essay, so grading is not from
-- memory and the student can be shown what was expected.
ALTER TABLE "QuizQuestion"
  ADD COLUMN IF NOT EXISTS "modelAnswer" TEXT NOT NULL DEFAULT '';
