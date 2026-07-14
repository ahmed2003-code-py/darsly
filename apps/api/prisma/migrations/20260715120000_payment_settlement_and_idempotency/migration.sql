-- Separation of duties + payment-event idempotency. All additive & nullable →
-- P3009-safe and idempotent on non-empty production tables.

-- 1) Payment.settledAt — when the earning became withdrawable (ledger-credited).
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3);

-- Backfill: every EXISTING paid payment is already reflected in the ledger and
-- its balance is withdrawable today. Mark it settled so this change never strands
-- an existing teacher balance (settledAt = when it was verified).
UPDATE "Payment" SET "settledAt" = COALESCE("paidAt", "updatedAt", "createdAt")
WHERE "status" = 'PAID' AND "settledAt" IS NULL;

-- 2) PaymentEvent.dedupeKey — stable transfer identity for hard idempotency.
ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_dedupeKey_key"
  ON "PaymentEvent"("dedupeKey");
