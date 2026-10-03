-- CreateEnum
CREATE TYPE "TeacherPayMethod" AS ENUM ('PER_SESSION', 'PERCENT_OF_COLLECTIONS', 'FIXED_PERIOD');

-- CreateEnum
CREATE TYPE "TeacherSettlementStatus" AS ENUM ('FINALIZED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "TeacherSettlementLineKind" AS ENUM ('SESSION', 'COLLECTION', 'FIXED');

-- CreateEnum
CREATE TYPE "TeacherSettlementAdjustmentKind" AS ENUM ('BONUS', 'DEDUCTION', 'CORRECTION');

-- CreateEnum
CREATE TYPE "TeacherSettlementPaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'OTHER');

-- CreateTable
CREATE TABLE "TeacherAgreement" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "method" "TeacherPayMethod" NOT NULL,
    "currency" TEXT NOT NULL,
    "rateCents" INTEGER,
    "percentBps" INTEGER,
    "groupIds" TEXT[],
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "requestKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedBy" TEXT,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TeacherAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherSettlement" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "TeacherSettlementStatus" NOT NULL DEFAULT 'FINALIZED',
    "grossCents" INTEGER NOT NULL,
    "adjustCents" INTEGER NOT NULL DEFAULT 0,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "requestKey" TEXT NOT NULL,
    "finalizedBy" TEXT NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TeacherSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherSettlementLine" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "teacherUserId" TEXT NOT NULL,
    "kind" "TeacherSettlementLineKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "voided" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TeacherSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherSettlementAdjustment" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "kind" "TeacherSettlementAdjustmentKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherSettlementAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherSettlementPayment" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "TeacherSettlementPaymentMethod" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestKey" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,

    CONSTRAINT "TeacherSettlementPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherAgreement_academyId_teacherUserId_idx" ON "TeacherAgreement"("academyId", "teacherUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAgreement_academyId_requestKey_key" ON "TeacherAgreement"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "TeacherSettlement_academyId_teacherUserId_periodFrom_idx" ON "TeacherSettlement"("academyId", "teacherUserId", "periodFrom");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSettlement_academyId_requestKey_key" ON "TeacherSettlement"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "TeacherSettlementLine_settlementId_idx" ON "TeacherSettlementLine"("settlementId");

-- CreateIndex
CREATE INDEX "TeacherSettlementAdjustment_settlementId_idx" ON "TeacherSettlementAdjustment"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSettlementAdjustment_academyId_requestKey_key" ON "TeacherSettlementAdjustment"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "TeacherSettlementPayment_settlementId_idx" ON "TeacherSettlementPayment"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSettlementPayment_academyId_requestKey_key" ON "TeacherSettlementPayment"("academyId", "requestKey");

-- AddForeignKey
ALTER TABLE "TeacherAgreement" ADD CONSTRAINT "TeacherAgreement_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSettlement" ADD CONSTRAINT "TeacherSettlement_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSettlementLine" ADD CONSTRAINT "TeacherSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "TeacherSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSettlementAdjustment" ADD CONSTRAINT "TeacherSettlementAdjustment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "TeacherSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSettlementPayment" ADD CONSTRAINT "TeacherSettlementPayment_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "TeacherSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Center Operations C8 guards ─────────────────────────────────────────────

-- Agreements: one method's numbers, a real currency, sane dates.
ALTER TABLE "TeacherAgreement" ADD CONSTRAINT "TeacherAgreement_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND "currency" ~ '^[A-Z]{3}$'
  AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
  AND (("endedAt" IS NULL) = ("endedBy" IS NULL))
  AND CASE "method"
        WHEN 'PER_SESSION' THEN "rateCents" BETWEEN 1 AND 10000000 AND "percentBps" IS NULL
        WHEN 'FIXED_PERIOD' THEN "rateCents" BETWEEN 1 AND 100000000 AND "percentBps" IS NULL AND cardinality("groupIds") = 0
        WHEN 'PERCENT_OF_COLLECTIONS' THEN "percentBps" BETWEEN 1 AND 10000 AND "rateCents" IS NULL AND cardinality("groupIds") > 0
      END
);

-- Agreements are never edited (a new rate is a new agreement) and never
-- deleted; only the end may be set — once. Two agreements of one method for
-- one teacher may not overlap in time where their groups overlap (an empty
-- scope means every group), so a class or a payment can match only one.
CREATE FUNCTION teacher_agreement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a teacher agreement is history and is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."academyId" <> OLD."academyId" OR NEW."teacherUserId" <> OLD."teacherUserId"
       OR NEW."method" <> OLD."method" OR NEW."currency" <> OLD."currency"
       OR NEW."rateCents" IS DISTINCT FROM OLD."rateCents" OR NEW."percentBps" IS DISTINCT FROM OLD."percentBps"
       OR NEW."groupIds" <> OLD."groupIds" OR NEW."effectiveFrom" <> OLD."effectiveFrom"
       OR NEW."requestKey" <> OLD."requestKey" OR NEW."createdBy" <> OLD."createdBy" OR NEW."createdAt" <> OLD."createdAt" THEN
      RAISE EXCEPTION 'a teacher agreement is never edited — end it and start a new one' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'this agreement has already ended' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('teacher-agreement:' || NEW."academyId"), hashtext(NEW."teacherUserId"));
  IF EXISTS (
    SELECT 1 FROM "TeacherAgreement" o
    WHERE o."academyId" = NEW."academyId" AND o."teacherUserId" = NEW."teacherUserId"
      AND o."method" = NEW."method" AND o.id <> NEW.id
      AND daterange(o."effectiveFrom", o."effectiveTo", '[]') && daterange(NEW."effectiveFrom", NEW."effectiveTo", '[]')
      AND (cardinality(o."groupIds") = 0 OR cardinality(NEW."groupIds") = 0 OR o."groupIds" && NEW."groupIds")
  ) THEN
    RAISE EXCEPTION 'overlapping teacher agreements' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TeacherAgreement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TeacherAgreement"
  FOR EACH ROW EXECUTE FUNCTION teacher_agreement_guard();

-- Settlements: money adds up; one teacher's non-void periods never overlap.
ALTER TABLE "TeacherSettlement" ADD CONSTRAINT "TeacherSettlement_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND "currency" ~ '^[A-Z]{3}$'
  AND "periodTo" >= "periodFrom" AND "periodTo" - "periodFrom" <= 92
  AND "grossCents" >= 0 AND "paidCents" >= 0
  AND "grossCents" + "adjustCents" >= 0
  AND "paidCents" <= "grossCents" + "adjustCents"
  AND CASE "status"
        WHEN 'VOID' THEN "paidCents" = 0 AND "voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL
                         AND char_length(btrim(coalesce("voidReason", ''))) BETWEEN 3 AND 300
        WHEN 'FINALIZED' THEN "paidCents" = 0 AND "voidedAt" IS NULL
        WHEN 'PARTIALLY_PAID' THEN "paidCents" > 0 AND "paidCents" < "grossCents" + "adjustCents" AND "voidedAt" IS NULL
        WHEN 'PAID' THEN "paidCents" > 0 AND "paidCents" = "grossCents" + "adjustCents" AND "voidedAt" IS NULL
      END
);
ALTER TABLE "TeacherSettlement" ADD CONSTRAINT "TeacherSettlement_no_overlap"
  EXCLUDE USING gist ("academyId" WITH =, "teacherUserId" WITH =, daterange("periodFrom", "periodTo", '[]') WITH &&)
  WHERE ("status" <> 'VOID');

-- A finalized settlement keeps what it is; only its payment state, its
-- adjustment total and a void (unpaid, final) move. Never deleted.
CREATE FUNCTION teacher_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a teacher settlement is history and is never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" = 'VOID' THEN
    RAISE EXCEPTION 'a void settlement is history' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."academyId" <> OLD."academyId" OR NEW."teacherUserId" <> OLD."teacherUserId"
     OR NEW."periodFrom" <> OLD."periodFrom" OR NEW."periodTo" <> OLD."periodTo"
     OR NEW."currency" <> OLD."currency" OR NEW."grossCents" <> OLD."grossCents"
     OR NEW."requestKey" <> OLD."requestKey" OR NEW."finalizedBy" <> OLD."finalizedBy" OR NEW."finalizedAt" <> OLD."finalizedAt" THEN
    RAISE EXCEPTION 'a finalized settlement keeps its teacher, period and gross amount' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."paidCents" < OLD."paidCents" THEN
    RAISE EXCEPTION 'recorded payments are never taken back' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."status" = 'VOID' THEN
    UPDATE "TeacherSettlementLine" SET "voided" = true WHERE "settlementId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TeacherSettlement_guard" BEFORE UPDATE OR DELETE ON "TeacherSettlement"
  FOR EACH ROW EXECUTE FUNCTION teacher_settlement_guard();

-- Lines: one source paid once per teacher across all live settlements.
CREATE UNIQUE INDEX "TeacherSettlementLine_once" ON "TeacherSettlementLine"("academyId", "teacherUserId", "kind", "sourceId")
  WHERE NOT "voided";
ALTER TABLE "TeacherSettlementLine" ADD CONSTRAINT "TeacherSettlementLine_shape" CHECK ("amountCents" >= 0);

CREATE FUNCTION teacher_settlement_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement lines are history' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Only the void flag moves, and only false → true.
    IF NEW."voided" = OLD."voided" OR OLD."voided" OR NEW."settlementId" <> OLD."settlementId"
       OR NEW."sourceId" <> OLD."sourceId" OR NEW."amountCents" <> OLD."amountCents" OR NEW."kind" <> OLD."kind"
       OR NEW."teacherUserId" <> OLD."teacherUserId" OR NEW."agreementId" <> OLD."agreementId" OR NEW."academyId" <> OLD."academyId" THEN
      RAISE EXCEPTION 'settlement lines are history' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "academyId", "teacherUserId", "status" INTO s FROM "TeacherSettlement" WHERE id = NEW."settlementId";
  IF s."academyId" IS DISTINCT FROM NEW."academyId" OR s."teacherUserId" IS DISTINCT FROM NEW."teacherUserId" THEN
    RAISE EXCEPTION 'settlement line crosses academies or teachers' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "TeacherAgreement" a WHERE a.id = NEW."agreementId"
                   AND a."academyId" = NEW."academyId" AND a."teacherUserId" = NEW."teacherUserId") THEN
    RAISE EXCEPTION 'settlement line names another teacher''s agreement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TeacherSettlementLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TeacherSettlementLine"
  FOR EACH ROW EXECUTE FUNCTION teacher_settlement_line_guard();

-- Adjustments and payments: append-only, signed/positive, inside one academy.
ALTER TABLE "TeacherSettlementAdjustment" ADD CONSTRAINT "TeacherSettlementAdjustment_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND char_length(btrim("reason")) BETWEEN 3 AND 300
  AND "amountCents" <> 0 AND abs("amountCents") <= 100000000
  AND CASE "kind" WHEN 'BONUS' THEN "amountCents" > 0 WHEN 'DEDUCTION' THEN "amountCents" < 0 ELSE true END
);
ALTER TABLE "TeacherSettlementPayment" ADD CONSTRAINT "TeacherSettlementPayment_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND "amountCents" > 0 AND "amountCents" <= 100000000
  AND ("reference" IS NULL OR char_length("reference") <= 60)
);
CREATE FUNCTION teacher_settlement_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "TeacherSettlement" s WHERE s.id = NEW."settlementId" AND s."academyId" = NEW."academyId" AND s."status" <> 'VOID') THEN
    RAISE EXCEPTION 'no live settlement for this record in this academy' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TeacherSettlementAdjustment_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "TeacherSettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION teacher_settlement_append_only();
CREATE TRIGGER "TeacherSettlementPayment_append_only" BEFORE INSERT OR UPDATE OR DELETE ON "TeacherSettlementPayment"
  FOR EACH ROW EXECUTE FUNCTION teacher_settlement_append_only();
