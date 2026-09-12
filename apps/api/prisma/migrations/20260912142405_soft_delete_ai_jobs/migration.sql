-- AlterTable
ALTER TABLE "AcademyProfileFacts" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AcademySiteSnapshot" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiJob" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

