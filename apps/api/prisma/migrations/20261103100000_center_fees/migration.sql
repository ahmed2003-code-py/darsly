-- Center Operations C4 — the center's own fees, charges, collections and receipts.
--
-- Additive only: new enums, tables, a view, functions and triggers. No existing
-- row is read or written; no plan, charge or collection is created (no back-
-- charging: only plans an owner creates ever post charges). Prisma's diff also
-- proposes dropping AcademyStudent_nameNormalized_trgm_idx: C1's hand-made index — kept.

-- CreateEnum
CREATE TYPE "CenterFeePlanType" AS ENUM ('MONTHLY', 'PER_SESSION');

-- CreateEnum
CREATE TYPE "CenterFeePlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CenterChargeKind" AS ENUM ('MONTHLY', 'PER_SESSION', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "CenterAdjustmentKind" AS ENUM ('DISCOUNT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "CenterCollectionMethod" AS ENUM ('CASH', 'CARD_EXTERNAL', 'BANK_TRANSFER', 'OTHER');


-- CreateTable
CREATE TABLE "CenterFeePlan" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CenterFeePlanType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDay" INTEGER,
    "startsOn" DATE NOT NULL,
    "status" "CenterFeePlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CenterFeePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterCharge" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "kind" "CenterChargeKind" NOT NULL,
    "planId" TEXT,
    "period" TEXT,
    "groupSessionId" TEXT,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "createdBy" TEXT,
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "CenterCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterAdjustment" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "kind" "CenterAdjustmentKind" NOT NULL,
    "deltaCents" INTEGER NOT NULL,
    "percentBps" INTEGER,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CenterAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterCollection" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "CenterCollectionMethod" NOT NULL,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "requestKey" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedBy" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "CenterCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterAllocation" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "CenterAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CenterReceiptCounter" (
    "academyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "CenterReceiptCounter_pkey" PRIMARY KEY ("academyId","year")
);

-- CreateIndex
CREATE INDEX "CenterFeePlan_academyId_status_idx" ON "CenterFeePlan"("academyId", "status");

-- CreateIndex
CREATE INDEX "CenterFeePlan_groupId_idx" ON "CenterFeePlan"("groupId");

-- CreateIndex
CREATE INDEX "CenterCharge_academyId_academyStudentId_idx" ON "CenterCharge"("academyId", "academyStudentId");

-- CreateIndex
CREATE INDEX "CenterCharge_academyId_dueOn_idx" ON "CenterCharge"("academyId", "dueOn");

-- CreateIndex
CREATE INDEX "CenterCharge_planId_idx" ON "CenterCharge"("planId");

-- CreateIndex
CREATE INDEX "CenterCharge_groupSessionId_idx" ON "CenterCharge"("groupSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CenterCharge_academyId_requestKey_key" ON "CenterCharge"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "CenterAdjustment_chargeId_idx" ON "CenterAdjustment"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "CenterAdjustment_academyId_requestKey_key" ON "CenterAdjustment"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "CenterCollection_academyId_receivedAt_idx" ON "CenterCollection"("academyId", "receivedAt");

-- CreateIndex
CREATE INDEX "CenterCollection_academyStudentId_idx" ON "CenterCollection"("academyStudentId");

-- CreateIndex
CREATE UNIQUE INDEX "CenterCollection_academyId_receiptNumber_key" ON "CenterCollection"("academyId", "receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CenterCollection_academyId_requestKey_key" ON "CenterCollection"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "CenterAllocation_chargeId_idx" ON "CenterAllocation"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "CenterAllocation_collectionId_chargeId_key" ON "CenterAllocation"("collectionId", "chargeId");

-- AddForeignKey
ALTER TABLE "CenterFeePlan" ADD CONSTRAINT "CenterFeePlan_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterFeePlan" ADD CONSTRAINT "CenterFeePlan_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CenterFeePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_groupSessionId_fkey" FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterAdjustment" ADD CONSTRAINT "CenterAdjustment_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "CenterCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCollection" ADD CONSTRAINT "CenterCollection_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterCollection" ADD CONSTRAINT "CenterCollection_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterAllocation" ADD CONSTRAINT "CenterAllocation_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CenterCollection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CenterAllocation" ADD CONSTRAINT "CenterAllocation_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "CenterCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── What the database itself guarantees (C4) ─────────────────────────────
--
-- This is the center's OWN money. No table here references, or is referenced
-- by, Payment / PaymentEvent / LedgerTransaction / LedgerEntry /
-- WalletTransaction / PayoutRequest / LivePurchase. Money is integer piasters
-- in a three-letter currency; amounts are bounded so every sum fits.

ALTER TABLE "CenterFeePlan" ADD CONSTRAINT "CenterFeePlan_shape" CHECK (
  "amountCents" BETWEEN 1 AND 100000000
  AND "currency" ~ '^[A-Z]{3}$'
  AND length(btrim("name")) > 0
  AND (("type" = 'MONTHLY' AND "dueDay" BETWEEN 1 AND 28) OR ("type" = 'PER_SESSION' AND "dueDay" IS NULL)));

ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_shape" CHECK (
  "amountCents" BETWEEN 1 AND 100000000
  AND "currency" ~ '^[A-Z]{3}$'
  AND length(btrim("description")) > 0
  AND CASE "kind"
    WHEN 'MONTHLY' THEN "planId" IS NOT NULL AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "groupSessionId" IS NULL
    WHEN 'PER_SESSION' THEN "planId" IS NOT NULL AND "groupSessionId" IS NOT NULL AND "period" IS NULL
    ELSE "planId" IS NULL AND "period" IS NULL AND "groupSessionId" IS NULL AND "requestKey" IS NOT NULL
  END);
ALTER TABLE "CenterCharge" ADD CONSTRAINT "CenterCharge_void_whole" CHECK (
  ("voidedAt" IS NULL) = ("voidedBy" IS NULL) AND ("voidedAt" IS NULL) = ("voidReason" IS NULL));

-- A learner owes a plan's month once, and a plan's class once: running the
-- generator twice (two replicas, a retry, a page load) posts nothing new.
CREATE UNIQUE INDEX "CenterCharge_monthly_once" ON "CenterCharge"("planId", "academyStudentId", "period")
  WHERE "kind" = 'MONTHLY';
CREATE UNIQUE INDEX "CenterCharge_session_once" ON "CenterCharge"("planId", "academyStudentId", "groupSessionId")
  WHERE "kind" = 'PER_SESSION';

ALTER TABLE "CenterAdjustment" ADD CONSTRAINT "CenterAdjustment_shape" CHECK (
  "deltaCents" <> 0 AND abs("deltaCents") <= 100000000
  AND ("kind" <> 'DISCOUNT' OR "deltaCents" < 0)
  AND ("percentBps" IS NULL OR "percentBps" BETWEEN 1 AND 10000)
  AND length(btrim("reason")) > 0);

ALTER TABLE "CenterCollection" ADD CONSTRAINT "CenterCollection_shape" CHECK (
  "amountCents" BETWEEN 1 AND 100000000
  AND "currency" ~ '^[A-Z]{3}$'
  AND "balanceAfterCents" >= 0
  AND "receiptNumber" ~ '^[0-9]{4}-[0-9]{6,}$');
ALTER TABLE "CenterCollection" ADD CONSTRAINT "CenterCollection_reversal_whole" CHECK (
  ("reversedAt" IS NULL) = ("reversedBy" IS NULL) AND ("reversedAt" IS NULL) = ("reversalReason" IS NULL));

ALTER TABLE "CenterAllocation" ADD CONSTRAINT "CenterAllocation_positive" CHECK ("amountCents" > 0);
ALTER TABLE "CenterReceiptCounter" ADD CONSTRAINT "CenterReceiptCounter_positive" CHECK ("last" > 0);

-- ── The balance: ONE definition ──────────────────────────────────────────
-- net     = posted amount + adjustments (0 once voided)
-- paid    = allocations of collections that are not reversed
-- outstanding = net - paid
-- Every screen, report and the receipt read this view; nothing else computes it.
CREATE VIEW "CenterChargeBalance" AS
  SELECT c.id AS "chargeId", c."academyId", c."academyStudentId", c."kind", c."dueOn", c."voidedAt",
         n.net AS "netCents", p.paid AS "paidCents", n.net - p.paid AS "outstandingCents"
  FROM "CenterCharge" c
  CROSS JOIN LATERAL (
    SELECT CASE WHEN c."voidedAt" IS NULL
                THEN c."amountCents" + COALESCE((SELECT sum(a."deltaCents") FROM "CenterAdjustment" a WHERE a."chargeId" = c.id), 0)::int
                ELSE 0 END AS net) n
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(al."amountCents"), 0)::int AS paid
    FROM "CenterAllocation" al JOIN "CenterCollection" k ON k.id = al."collectionId"
    WHERE al."chargeId" = c.id AND k."reversedAt" IS NULL) p;
-- The triggers below ask the same view: there is no second formula.
CREATE FUNCTION center_charge_net(charge_id text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT "netCents" FROM "CenterChargeBalance" WHERE "chargeId" = charge_id
$$;
CREATE FUNCTION center_charge_paid(charge_id text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT "paidCents" FROM "CenterChargeBalance" WHERE "chargeId" = charge_id
$$;

-- ── History is append-only ───────────────────────────────────────────────
CREATE FUNCTION center_fees_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are financial history and are never deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "CenterFeePlan_no_delete" BEFORE DELETE ON "CenterFeePlan" FOR EACH ROW EXECUTE FUNCTION center_fees_no_delete();
CREATE TRIGGER "CenterCharge_no_delete" BEFORE DELETE ON "CenterCharge" FOR EACH ROW EXECUTE FUNCTION center_fees_no_delete();
CREATE TRIGGER "CenterAdjustment_no_delete" BEFORE DELETE ON "CenterAdjustment" FOR EACH ROW EXECUTE FUNCTION center_fees_no_delete();
CREATE TRIGGER "CenterCollection_no_delete" BEFORE DELETE ON "CenterCollection" FOR EACH ROW EXECUTE FUNCTION center_fees_no_delete();
CREATE TRIGGER "CenterAllocation_no_delete" BEFORE DELETE ON "CenterAllocation" FOR EACH ROW EXECUTE FUNCTION center_fees_no_delete();

CREATE FUNCTION center_fees_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never edited', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER "CenterAdjustment_no_update" BEFORE UPDATE ON "CenterAdjustment" FOR EACH ROW EXECUTE FUNCTION center_fees_no_update();
CREATE TRIGGER "CenterAllocation_no_update" BEFORE UPDATE ON "CenterAllocation" FOR EACH ROW EXECUTE FUNCTION center_fees_no_update();

-- A posted charge keeps what it was; the only change is being voided, once.
CREATE FUNCTION center_charge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AcademyStudent" s WHERE s.id = NEW."academyStudentId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'CenterCharge % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CenterFeePlan" p WHERE p.id = NEW."planId" AND p."academyId" = NEW."academyId" AND p."currency" = NEW."currency") THEN
    RAISE EXCEPTION 'CenterCharge % plan crosses academies or currencies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."groupSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "GroupSession" g WHERE g.id = NEW."groupSessionId" AND g."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'CenterCharge % class crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."academyId", NEW."academyStudentId", NEW."kind", NEW."planId", NEW."period", NEW."groupSessionId",
        NEW."description", NEW."amountCents", NEW."currency", NEW."dueOn", NEW."createdBy", NEW."requestKey", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."academyId", OLD."academyStudentId", OLD."kind", OLD."planId", OLD."period", OLD."groupSessionId",
        OLD."description", OLD."amountCents", OLD."currency", OLD."dueOn", OLD."createdBy", OLD."requestKey", OLD."createdAt") THEN
      RAISE EXCEPTION 'CenterCharge % is posted and never rewritten', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."voidedAt" IS NOT NULL AND (NEW."voidedAt", NEW."voidedBy", NEW."voidReason")
       IS DISTINCT FROM (OLD."voidedAt", OLD."voidedBy", OLD."voidReason") THEN
      RAISE EXCEPTION 'CenterCharge % is void for good', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."voidedAt" IS NOT NULL AND center_charge_paid(NEW.id) > 0 THEN
      RAISE EXCEPTION 'CenterCharge % has money against it; reverse the collection first', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CenterCharge_guard" BEFORE INSERT OR UPDATE ON "CenterCharge"
  FOR EACH ROW EXECUTE FUNCTION center_charge_guard();

-- A plan keeps its academy, group, type and currency; name, amount, due day,
-- start and status may change (posted charges keep their own amount).
CREATE FUNCTION center_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = NEW."groupId" AND g."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'CenterFeePlan % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."academyId", NEW."groupId", NEW."type", NEW."currency", NEW."createdBy")
     IS DISTINCT FROM (OLD."academyId", OLD."groupId", OLD."type", OLD."currency", OLD."createdBy") THEN
    RAISE EXCEPTION 'CenterFeePlan % keeps its group, type and currency', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CenterFeePlan_guard" BEFORE INSERT OR UPDATE ON "CenterFeePlan"
  FOR EACH ROW EXECUTE FUNCTION center_plan_guard();

-- A collection (and its receipt) never changes; the only change is being
-- reversed, once.
CREATE FUNCTION center_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AcademyStudent" s WHERE s.id = NEW."academyStudentId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'CenterCollection % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."academyId", NEW."academyStudentId", NEW."amountCents", NEW."currency", NEW."method", NEW."note",
        NEW."receivedAt", NEW."receivedBy", NEW."receiptNumber", NEW."balanceAfterCents", NEW."requestKey")
       IS DISTINCT FROM
       (OLD."academyId", OLD."academyStudentId", OLD."amountCents", OLD."currency", OLD."method", OLD."note",
        OLD."receivedAt", OLD."receivedBy", OLD."receiptNumber", OLD."balanceAfterCents", OLD."requestKey") THEN
      RAISE EXCEPTION 'CenterCollection % and its receipt are never rewritten', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."reversedAt" IS NOT NULL AND (NEW."reversedAt", NEW."reversedBy", NEW."reversalReason")
       IS DISTINCT FROM (OLD."reversedAt", OLD."reversedBy", OLD."reversalReason") THEN
      RAISE EXCEPTION 'CenterCollection % is reversed for good', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CenterCollection_guard" BEFORE INSERT OR UPDATE ON "CenterCollection"
  FOR EACH ROW EXECUTE FUNCTION center_collection_guard();

-- Money balances, checked when the transaction commits (so a collection and
-- its allocations, written together, are judged together):
--  • a collection is fully allocated — no money without a purpose, no credit;
--  • an allocation pays a charge of the same learner, academy and currency
--    that is not void, and never beyond what it still owes;
--  • an adjustment never takes a charge below what was already paid, or below 0.
CREATE FUNCTION center_collection_allocated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated bigint;
BEGIN
  SELECT COALESCE(sum("amountCents"), 0) INTO allocated FROM "CenterAllocation" WHERE "collectionId" = NEW.id;
  IF allocated <> NEW."amountCents" THEN
    RAISE EXCEPTION 'CenterCollection % is not fully allocated (% of %)', NEW.id, allocated, NEW."amountCents" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CenterCollection_allocated" AFTER INSERT ON "CenterCollection"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION center_collection_allocated();

CREATE FUNCTION center_allocation_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k "CenterCollection"%ROWTYPE; c "CenterCharge"%ROWTYPE;
BEGIN
  SELECT * INTO k FROM "CenterCollection" WHERE id = NEW."collectionId";
  SELECT * INTO c FROM "CenterCharge" WHERE id = NEW."chargeId";
  IF k."academyId" <> NEW."academyId" OR c."academyId" <> NEW."academyId"
     OR k."academyStudentId" <> c."academyStudentId" OR k."currency" <> c."currency" THEN
    RAISE EXCEPTION 'CenterAllocation % mixes academies, learners or currencies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF c."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CenterAllocation % pays a void charge', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF center_charge_paid(c.id) > center_charge_net(c.id) THEN
    RAISE EXCEPTION 'CenterCharge % would be over-paid', c.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CenterAllocation_check" AFTER INSERT ON "CenterAllocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION center_allocation_check();

CREATE FUNCTION center_adjustment_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "CenterCharge"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "CenterCharge" WHERE id = NEW."chargeId";
  IF c."academyId" <> NEW."academyId" THEN
    RAISE EXCEPTION 'CenterAdjustment % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF c."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'CenterAdjustment % adjusts a void charge', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF center_charge_net(c.id) < 0 OR center_charge_net(c.id) < center_charge_paid(c.id) THEN
    RAISE EXCEPTION 'CenterCharge % would owe less than nothing or less than was paid', c.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "CenterAdjustment_check" AFTER INSERT ON "CenterAdjustment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION center_adjustment_check();
