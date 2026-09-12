-- How much of a payment's total was covered by the student's wallet balance.
-- Zero for every existing row (none of them could have been — the wallet
-- didn't exist yet), which is exactly what DEFAULT 0 backfills them to.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "walletCents" INTEGER NOT NULL DEFAULT 0;
