-- Live Commerce A: Darsly's versioned commercial terms, and FREE/PAID sessions.
--
-- Additive only. Every existing LiveSession becomes FREE (the column default),
-- which is exactly what every existing session is. Courses are untouched: they
-- keep reading Academy.feeType/feeValue.

-- CreateEnum
CREATE TYPE "CommercialFeeMode" AS ENUM ('ADDITIVE', 'DEDUCTED');

-- CreateEnum
CREATE TYPE "LiveAccessMode" AS ENUM ('FREE', 'PAID');

-- CreateEnum
CREATE TYPE "LiveRefundPolicy" AS ENUM ('FLEXIBLE', 'STANDARD', 'STRICT', 'NO_REFUND');

-- CreateEnum
CREATE TYPE "LiveReplayPolicy" AS ENUM ('NONE', 'INCLUDED_FOREVER', 'INCLUDED_DAYS');

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "accessMode" "LiveAccessMode" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EGP',
ADD COLUMN     "priceCents" INTEGER,
ADD COLUMN     "refundPolicy" "LiveRefundPolicy" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "replayDays" INTEGER,
ADD COLUMN     "replayPolicy" "LiveReplayPolicy" NOT NULL DEFAULT 'INCLUDED_FOREVER';

-- A FREE session has no price; a PAID one has a positive one. Never inferred.
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_price_matches_mode_check" CHECK (
  ("accessMode" = 'FREE' AND "priceCents" IS NULL)
  OR ("accessMode" = 'PAID' AND "priceCents" IS NOT NULL AND "priceCents" > 0)
);
-- Days of replay exist exactly when the policy counts them.
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_replay_days_check" CHECK (
  ("replayPolicy" = 'INCLUDED_DAYS' AND "replayDays" IS NOT NULL AND "replayDays" BETWEEN 1 AND 3650)
  OR ("replayPolicy" <> 'INCLUDED_DAYS' AND "replayDays" IS NULL)
);

-- CreateTable
CREATE TABLE "CommercialTerms" (
    "id" TEXT NOT NULL,
    "academyId" TEXT,
    "feeType" "FeeType" NOT NULL,
    "feeBps" INTEGER,
    "feeFixedCents" INTEGER,
    "feeMode" "CommercialFeeMode" NOT NULL,
    "feeRefundableOnStudentCancel" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommercialTerms_pkey" PRIMARY KEY ("id")
);

-- Exactly one of a percentage (basis points) or a fixed amount (piasters).
ALTER TABLE "CommercialTerms" ADD CONSTRAINT "CommercialTerms_fee_shape_check" CHECK (
  ("feeType" = 'PERCENT' AND "feeBps" IS NOT NULL AND "feeBps" BETWEEN 0 AND 10000 AND "feeFixedCents" IS NULL)
  OR ("feeType" = 'FIXED' AND "feeFixedCents" IS NOT NULL AND "feeFixedCents" >= 0 AND "feeBps" IS NULL)
);
-- A deducted fee of 100% or more would leave the seller nothing (a fixed
-- deducted fee is checked against each price, where the price is known).
ALTER TABLE "CommercialTerms" ADD CONSTRAINT "CommercialTerms_deducted_bps_check" CHECK (
  NOT ("feeMode" = 'DEDUCTED' AND "feeType" = 'PERCENT' AND "feeBps" >= 10000)
);

-- CreateIndex
CREATE INDEX "CommercialTerms_academyId_effectiveFrom_idx" ON "CommercialTerms"("academyId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "CommercialTerms" ADD CONSTRAINT "CommercialTerms_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: a version, once written, is what purchases were priced under.
-- Changing the terms is a new row; editing an old one is refused here, below
-- any application code that might forget.
CREATE OR REPLACE FUNCTION "commercial_terms_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CommercialTerms rows are immutable; insert a new version instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CommercialTerms_no_update"
  BEFORE UPDATE ON "CommercialTerms"
  FOR EACH ROW EXECUTE FUNCTION "commercial_terms_append_only"();

-- Seed. Timestamps are written in UTC explicitly: Prisma stores UTC in these
-- zone-less columns, and a bare CURRENT_TIMESTAMP would be the server's local
-- time — a default that "starts" hours in the future on a non-UTC server.
--
-- The platform default is what every academy is charged today: 20%,
-- added on top (Academy.feeValue's default, and FeeType's additive meaning).
INSERT INTO "CommercialTerms" ("id", "academyId", "feeType", "feeBps", "feeFixedCents", "feeMode", "feeRefundableOnStudentCancel", "note", "effectiveFrom", "createdAt")
VALUES ('ct_platform_default_v1', NULL, 'PERCENT', 2000, NULL, 'ADDITIVE', false,
        'Seeded: the platform default at the start of Live commerce (20% additive).',
        now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC');

-- An academy that was agreed something other than the default keeps it for
-- Live too: its current Academy.feeType/feeValue, as an additive fee.
INSERT INTO "CommercialTerms" ("id", "academyId", "feeType", "feeBps", "feeFixedCents", "feeMode", "feeRefundableOnStudentCancel", "note", "effectiveFrom", "createdAt")
SELECT 'ct_seed_' || md5(a."id"), a."id", a."feeType",
       CASE WHEN a."feeType" = 'PERCENT' THEN LEAST(GREATEST(a."feeValue", 0), 100) * 100 END,
       CASE WHEN a."feeType" = 'FIXED' THEN GREATEST(a."feeValue", 0) END,
       'ADDITIVE', false,
       'Seeded from Academy.feeType/feeValue at the start of Live commerce.',
       now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
FROM "Academy" a
WHERE NOT (a."feeType" = 'PERCENT' AND a."feeValue" = 20);
