-- CreateEnum
CREATE TYPE "ChallengeType" AS ENUM ('PRACTICE', 'RANKED');

-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChallengeScoring" AS ENUM ('STANDARD', 'SPEED_BASED');

-- CreateEnum
CREATE TYPE "ChallengeAnswerReveal" AS ENUM ('IMMEDIATE', 'AFTER_SUBMISSION', 'AFTER_CLOSE', 'NEVER');

-- CreateEnum
CREATE TYPE "ChallengeRandomize" AS ENUM ('NONE', 'QUESTIONS', 'ANSWERS', 'BOTH');

-- CreateEnum
CREATE TYPE "ChallengeAttemptStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'TIMED_OUT', 'ABANDONED');

-- AlterTable
ALTER TABLE "StudentGamification" ADD COLUMN     "challengesCompleted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "challengesWon" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "perfectChallenges" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "coverIcon" TEXT NOT NULL DEFAULT 'bolt',
    "type" "ChallengeType" NOT NULL DEFAULT 'PRACTICE',
    "status" "ChallengeStatus" NOT NULL DEFAULT 'DRAFT',
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "courseId" TEXT,
    "subjectId" TEXT,
    "gradeId" TEXT,
    "topic" TEXT,
    "durationSec" INTEGER,
    "questionTimeSec" INTEGER,
    "scoring" "ChallengeScoring" NOT NULL DEFAULT 'STANDARD',
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "answerReveal" "ChallengeAnswerReveal" NOT NULL DEFAULT 'AFTER_SUBMISSION',
    "randomize" "ChallengeRandomize" NOT NULL DEFAULT 'NONE',
    "publishedAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeQuestion" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL DEFAULT 'MCQ',
    "prompt" TEXT NOT NULL,
    "imageUrl" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "correctOptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "explanation" TEXT NOT NULL DEFAULT '',
    "points" INTEGER NOT NULL DEFAULT 100,
    "timeLimitSec" INTEGER,
    "topic" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeAttempt" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "ChallengeAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "wrongCount" INTEGER NOT NULL DEFAULT 0,
    "accuracyPct" INTEGER,
    "speedPct" INTEGER,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "coinsAwarded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChallengeAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChallengeAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedOptionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "timeTakenMs" INTEGER,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChallengeAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Challenge_tenantId_status_idx" ON "Challenge"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Challenge_status_publishedAt_idx" ON "Challenge"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Challenge_courseId_idx" ON "Challenge"("courseId");

-- CreateIndex
CREATE INDEX "ChallengeQuestion_challengeId_sortOrder_idx" ON "ChallengeQuestion"("challengeId", "sortOrder");

-- CreateIndex
CREATE INDEX "ChallengeAttempt_challengeId_status_idx" ON "ChallengeAttempt"("challengeId", "status");

-- CreateIndex
CREATE INDEX "ChallengeAttempt_studentId_status_idx" ON "ChallengeAttempt"("studentId", "status");

-- CreateIndex
CREATE INDEX "ChallengeAttempt_challengeId_score_idx" ON "ChallengeAttempt"("challengeId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeAttempt_challengeId_studentId_attemptNumber_key" ON "ChallengeAttempt"("challengeId", "studentId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ChallengeAnswer_attemptId_idx" ON "ChallengeAnswer"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "ChallengeAnswer_attemptId_questionId_key" ON "ChallengeAnswer"("attemptId", "questionId");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "GradeLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeQuestion" ADD CONSTRAINT "ChallengeQuestion_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeAttempt" ADD CONSTRAINT "ChallengeAttempt_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeAttempt" ADD CONSTRAINT "ChallengeAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeAnswer" ADD CONSTRAINT "ChallengeAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ChallengeAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChallengeAnswer" ADD CONSTRAINT "ChallengeAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ChallengeQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Two new gamification event types for the Challenges feature. CHALLENGE_WON
-- was already seeded (xpr_challenge_won, 75xp/40coins) waiting for this
-- feature; these two are new. Their xp/coins are floor defaults only — every
-- real award passes xpOverride from the server-side scoring engine, but
-- GamificationService.record() no-ops entirely when no XpRule row exists for
-- the event, so both need a row to ever pay out. dailyCap is 0 (uncapped) for
-- CHALLENGE_COMPLETED because, unlike a heartbeat-driven event, its XP is the
-- sum of a whole attempt's worth of teacher-authored questions, not a flat
-- per-action reward — a low cap would zero out ordinary play.
INSERT INTO "XpRule" ("id", "event", "xp", "coins", "dailyCap", "perEntityLimit", "isActive", "updatedAt") VALUES
  ('xpr_challenge_completed', 'CHALLENGE_COMPLETED', 20, 5,  0, 0, true, NOW()),
  ('xpr_challenge_perfect',   'CHALLENGE_PERFECT',   40, 20, 0, 1, true, NOW());
