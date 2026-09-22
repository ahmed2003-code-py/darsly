-- Architecture Reset Phase 7: scoped finance + cash payments.
-- Additive only. Nullable first; backfills are deterministic (organisation
-- scope == author scope for every pre-existing PERSONAL row, the Phase 4
-- invariant). Nothing is dropped, renamed or narrowed.

-- Cash as a payment method + the two cash dimensions.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CASH';
CREATE TYPE "CashOrigin" AS ENUM ('STUDENT_REPORTED', 'TEACHER_RECORDED', 'CENTER_RECORDED');
CREATE TYPE "CashReceiver" AS ENUM ('TEACHER', 'CENTER');

ALTER TABLE "Payment"
  ADD COLUMN "cashOrigin" "CashOrigin",
  ADD COLUMN "cashReceiver" "CashReceiver",
  ADD COLUMN "recordedByUserId" TEXT,
  ADD COLUMN "note" TEXT;

-- Revenue split configuration (CENTER only; NULL = not agreed, refused at sale).
ALTER TABLE "Academy" ADD COLUMN "teacherSharePercent" INTEGER;
ALTER TABLE "AcademyMembership" ADD COLUMN "revenueSharePercent" INTEGER;

-- Ledger entries carry the organisation they belong to.
ALTER TABLE "LedgerEntry" ADD COLUMN "academyId" TEXT;
UPDATE "LedgerEntry" SET "academyId" = "tenantId" WHERE "academyId" IS NULL AND "tenantId" IS NOT NULL;
CREATE INDEX "LedgerEntry_academyId_idx" ON "LedgerEntry"("academyId");

-- Payouts belong to an organisation's balance account, not only to a teacher.
ALTER TABLE "PayoutMethodSaved" ADD COLUMN "academyId" TEXT;
UPDATE "PayoutMethodSaved" SET "academyId" = "tenantId" WHERE "academyId" IS NULL;
ALTER TABLE "PayoutMethodSaved" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "PayoutMethodSaved" ADD CONSTRAINT "PayoutMethodSaved_academyId_fkey"
  FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayoutRequest" ADD COLUMN "academyId" TEXT;
UPDATE "PayoutRequest" SET "academyId" = "tenantId" WHERE "academyId" IS NULL;
ALTER TABLE "PayoutRequest" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_academyId_fkey"
  FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "PayoutRequest_academyId_idx" ON "PayoutRequest"("academyId");
