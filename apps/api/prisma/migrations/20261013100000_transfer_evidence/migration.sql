-- Transfer evidence and recovery: where the buyer says the money comes from,
-- when they said they sent it, and a tracked return of money that belongs to
-- no purchase. Additive only: new enums, new nullable columns, a new table and
-- one new enum value. Every existing row stays valid as it is.

-- CreateEnum
CREATE TYPE "TransferSource" AS ENUM ('WALLET', 'BANK');

-- CreateEnum
CREATE TYPE "TransferReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'COMPLETED', 'CANCELLED');

-- AlterEnum (the value is not used anywhere in this migration)
ALTER TYPE "PaymentEventStatus" ADD VALUE 'RETURNED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "payerName" TEXT,
ADD COLUMN     "transferSource" "TransferSource";

-- A Live payment created before this change was always created WITH its
-- proof, i.e. already claimed. Say so, so it is not mistaken for a payment
-- still waiting for its transfer.
UPDATE "Payment" SET "claimedAt" = "createdAt"
WHERE "livePurchaseId" IS NOT NULL AND "claimedAt" IS NULL AND "method" <> 'WALLET';

-- CreateTable
CREATE TABLE "TransferReturn" (
    "id" TEXT NOT NULL,
    "paymentEventId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "destinationMethod" "PayoutMethod" NOT NULL,
    "destinationDetails" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TransferReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "transferReference" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferReturn_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TransferReturn_amount_positive" CHECK ("amountCents" > 0),
    -- A completed return names the transfer that sent the money back.
    CONSTRAINT "TransferReturn_completed_has_reference" CHECK (
      "status" <> 'COMPLETED' OR ("transferReference" IS NOT NULL AND "completedAt" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "TransferReturn_paymentEventId_key" ON "TransferReturn"("paymentEventId");

-- CreateIndex
CREATE INDEX "TransferReturn_status_createdAt_idx" ON "TransferReturn"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TransferReturn" ADD CONSTRAINT "TransferReturn_paymentEventId_fkey" FOREIGN KEY ("paymentEventId") REFERENCES "PaymentEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
