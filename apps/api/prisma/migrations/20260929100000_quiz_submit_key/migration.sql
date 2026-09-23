-- One sitting, one attempt. Additive: two nullable columns and a unique index
-- over them. Existing rows all have a NULL key, and Postgres never treats two
-- NULLs as equal, so the index cannot conflict with anything already stored.
ALTER TABLE "QuizAttempt" ADD COLUMN IF NOT EXISTS "submitKey" TEXT;
ALTER TABLE "QuizAttempt" ADD COLUMN IF NOT EXISTS "submitResult" JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS "QuizAttempt_quizId_studentId_submitKey_key"
  ON "QuizAttempt"("quizId", "studentId", "submitKey");
