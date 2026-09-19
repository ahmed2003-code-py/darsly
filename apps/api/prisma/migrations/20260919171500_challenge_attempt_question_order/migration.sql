-- AlterTable
ALTER TABLE "ChallengeAttempt" ADD COLUMN     "questionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "retryOfAttemptId" TEXT;
