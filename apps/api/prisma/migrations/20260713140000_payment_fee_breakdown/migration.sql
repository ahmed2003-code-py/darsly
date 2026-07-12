-- Additive service-fee breakdown on payments. Nullable columns → P3009-safe,
-- idempotent. amountCents (total paid) = netCents (academy) + feeCents (platform).
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "feeCents" INTEGER;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "netCents" INTEGER;
