/*
  Warnings:

  - Added the required column `updatedAt` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY', 'VODAFONE_CASH', 'BANK_TRANSFER', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "method" "PaymentMethod",
ADD COLUMN     "proofImageUrl" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "rejectedReason" TEXT,
-- Backfill existing rows via a default, then drop it to match the @updatedAt schema.
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "verifiedById" TEXT,
ALTER COLUMN "gateway" SET DEFAULT 'manual';
ALTER TABLE "Payment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PlatformPaymentAccount" (
    "id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "label" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_studentId_status_idx" ON "Payment"("studentId", "status");
