-- A student saying "this question is wrong".
--
-- A key typed in by hand is a key that is sometimes typed in wrong, and the
-- people who find out are the students who answered correctly and were marked
-- down for it. They had nowhere to say so, and nothing tied a complaint to the
-- question it was about.
CREATE TYPE "QuestionReportStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');

CREATE TABLE "QuestionReport" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "QuestionReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuestionReport_pkey" PRIMARY KEY ("id")
);

-- One per student per question: a student is registering a doubt, not voting.
CREATE UNIQUE INDEX "QuestionReport_questionId_studentId_key" ON "QuestionReport"("questionId", "studentId");
CREATE INDEX "QuestionReport_status_createdAt_idx" ON "QuestionReport"("status", "createdAt");

ALTER TABLE "QuestionReport" ADD CONSTRAINT "QuestionReport_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionReport" ADD CONSTRAINT "QuestionReport_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
