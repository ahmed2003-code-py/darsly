-- CreateEnum
CREATE TYPE "PaymentEventStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'DUPLICATE');

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentMethod" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reference" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawMessage" TEXT NOT NULL DEFAULT '',
    "deviceId" TEXT,
    "status" "PaymentEventStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedPaymentId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentEvent_status_createdAt_idx" ON "PaymentEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentEvent_provider_amountCents_occurredAt_idx" ON "PaymentEvent"("provider", "amountCents", "occurredAt");
