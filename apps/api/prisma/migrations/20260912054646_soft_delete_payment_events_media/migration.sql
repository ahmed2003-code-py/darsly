-- AlterTable
ALTER TABLE "AcademyMedia" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

