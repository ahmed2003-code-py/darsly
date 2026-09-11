-- Student prepaid wallet: a spendable balance derived from the ledger
-- (account `student:<id>:wallet`), plus the two tables the student and admin
-- screens read. Everything here is additive — new enums, new tables, no
-- change to an existing column — so it is safe against a populated database.

-- CreateEnum
-- Guarded: a bare CREATE TYPE fails outright if it already exists, which on the
-- deploy path (prisma migrate deploy at boot) means a crash-looping API rather
-- than a skipped statement.
DO $$ BEGIN
  CREATE TYPE "WalletTxnKind" AS ENUM ('TOPUP', 'PURCHASE', 'REFUND', 'ADJUST');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WalletTopupStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WalletTransaction" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" "WalletTxnKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "paymentId" TEXT,
    "courseId" TEXT,
    "lessonId" TEXT,
    "ledgerTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WalletTopup" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "method" "PaymentMethod" NOT NULL,
    "proofImageUrl" TEXT NOT NULL,
    "reference" TEXT,
    "status" "WalletTopupStatus" NOT NULL DEFAULT 'PENDING',
    "rejectedReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WalletTransaction_studentId_createdAt_idx" ON "WalletTransaction"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WalletTopup_status_createdAt_idx" ON "WalletTopup"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WalletTopup_studentId_createdAt_idx" ON "WalletTopup"("studentId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "WalletTopup" ADD CONSTRAINT "WalletTopup_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
