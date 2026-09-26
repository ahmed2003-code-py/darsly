-- Live Commerce B: purchases, the Payment target, refunds, ledger idempotency.
--
-- Additive. Payment.courseId becomes nullable only so a Live seat can be the
-- thing a payment buys; every existing row is a course payment and satisfies
-- the new CHECK as it stands. Nothing existing is rewritten.

-- CreateEnum
CREATE TYPE "LivePurchaseStatus" AS ENUM ('HELD', 'PAYMENT_PENDING', 'CONFIRMED', 'DELIVERED', 'EXPIRED', 'PAYMENT_REJECTED', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_TEACHER', 'REFUND_PENDING', 'REFUNDED', 'OVERSOLD', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RefundDestination" AS ENUM ('WALLET', 'MANUAL_TRANSFER');

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('STUDENT_CANCEL', 'TEACHER_CANCEL', 'OVERSOLD', 'NO_SHOW', 'ADMIN');

-- AlterTable
ALTER TABLE "LedgerTransaction" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "LiveBooking" ADD COLUMN     "purchaseId" TEXT;

-- AlterTable (the foreign key keeps ON DELETE RESTRICT, as before)
ALTER TABLE "Payment" ADD COLUMN     "livePurchaseId" TEXT,
ALTER COLUMN "courseId" DROP NOT NULL;

-- A payment buys exactly one thing: a course, or a Live seat.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_exactly_one_target_check" CHECK (
  ("courseId" IS NOT NULL AND "livePurchaseId" IS NULL)
  OR ("courseId" IS NULL AND "livePurchaseId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "LivePurchase" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT,
    "status" "LivePurchaseStatus" NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "academyId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "basePriceCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "couponId" TEXT,
    "feeType" "FeeType" NOT NULL,
    "feeMode" "CommercialFeeMode" NOT NULL,
    "feeBps" INTEGER,
    "feeFixedCents" INTEGER,
    "feeCents" INTEGER NOT NULL,
    "studentPaysCents" INTEGER NOT NULL,
    "teacherCents" INTEGER NOT NULL,
    "centerCents" INTEGER NOT NULL,
    "teacherSharePercent" INTEGER,
    "termsVersionId" TEXT NOT NULL,
    "feeRefundableOnStudentCancel" BOOLEAN NOT NULL,
    "refundPolicy" "LiveRefundPolicy" NOT NULL,
    "replayPolicy" "LiveReplayPolicy" NOT NULL,
    "replayDays" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LivePurchase_pkey" PRIMARY KEY ("id")
);

-- The price balances, piaster for piaster, and nothing is negative.
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_amounts_check" CHECK (
  "basePriceCents" > 0
  AND "discountCents" >= 0 AND "discountCents" <= "basePriceCents"
  AND "feeCents" >= 0 AND "teacherCents" >= 0 AND "centerCents" >= 0
  AND "studentPaysCents" >= 0
  AND "studentPaysCents" = "feeCents" + "teacherCents" + "centerCents"
);
-- A purchase has a buyer (a guest buyer arrives in a later migration).
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_buyer_check" CHECK ("studentId" IS NOT NULL);
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_replay_days_check" CHECK (
  ("replayPolicy" = 'INCLUDED_DAYS' AND "replayDays" IS NOT NULL AND "replayDays" > 0)
  OR ("replayPolicy" <> 'INCLUDED_DAYS' AND "replayDays" IS NULL)
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "livePurchaseId" TEXT NOT NULL,
    "paymentId" TEXT,
    "reason" "RefundReason" NOT NULL,
    "destination" "RefundDestination" NOT NULL,
    "status" "RefundStatus" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeRefundCents" INTEGER NOT NULL,
    "teacherRefundCents" INTEGER NOT NULL,
    "centerRefundCents" INTEGER NOT NULL,
    "destinationMethod" "PayoutMethod",
    "destinationDetails" JSONB,
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "transferReference" TEXT,
    "rejectedReason" TEXT,
    "note" TEXT,
    "ledgerTxnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- A refund returns something, and its parts add up to it.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amounts_check" CHECK (
  "amountCents" > 0
  AND "feeRefundCents" >= 0 AND "teacherRefundCents" >= 0 AND "centerRefundCents" >= 0
  AND "amountCents" = "feeRefundCents" + "teacherRefundCents" + "centerRefundCents"
);

-- CreateIndex
CREATE INDEX "LivePurchase_sessionId_status_idx" ON "LivePurchase"("sessionId", "status");

-- CreateIndex
CREATE INDEX "LivePurchase_studentId_status_idx" ON "LivePurchase"("studentId", "status");

-- CreateIndex
CREATE INDEX "LivePurchase_status_holdExpiresAt_idx" ON "LivePurchase"("status", "holdExpiresAt");

-- One live purchase per student per session at a time: a double click, a
-- second tab or a retried request lands on this index instead of buying (or
-- holding) a second seat. Terminal states are outside it, so a student can
-- buy again after an expired hold, a rejected payment or a refund.
CREATE UNIQUE INDEX "LivePurchase_one_active_per_student" ON "LivePurchase"("sessionId", "studentId")
  WHERE "studentId" IS NOT NULL
    AND "status" IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW');

-- CreateIndex
CREATE UNIQUE INDEX "Refund_ledgerTxnId_key" ON "Refund"("ledgerTxnId");

-- CreateIndex
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_livePurchaseId_reason_key" ON "Refund"("livePurchaseId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LiveBooking_purchaseId_key" ON "LiveBooking"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_livePurchaseId_key" ON "Payment"("livePurchaseId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_livePurchaseId_fkey" FOREIGN KEY ("livePurchaseId") REFERENCES "LivePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveBooking" ADD CONSTRAINT "LiveBooking_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "LivePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_termsVersionId_fkey" FOREIGN KEY ("termsVersionId") REFERENCES "CommercialTerms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_livePurchaseId_fkey" FOREIGN KEY ("livePurchaseId") REFERENCES "LivePurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
