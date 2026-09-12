-- A transfer can now settle either a course payment or a wallet top-up. They
-- live in different tables, so the event records which one it credited.
-- Additive and nullable: safe against a populated table, and safe to re-run.
ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "matchedTopupId" TEXT;
