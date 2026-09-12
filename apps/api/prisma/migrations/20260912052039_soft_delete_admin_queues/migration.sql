-- AlterTable
ALTER TABLE "AcademySite" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayoutRequest" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WalletTopup" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

