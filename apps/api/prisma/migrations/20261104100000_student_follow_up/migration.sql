-- CreateEnum
CREATE TYPE "FollowUpReason" AS ENUM ('ABSENT_TODAY', 'ABSENT_STREAK', 'LATE_STREAK', 'FEES_OVERDUE', 'MANUAL');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('PHONE_CALL', 'WHATSAPP', 'IN_PERSON', 'APP_MESSAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactOutcome" AS ENUM ('REACHED', 'NO_ANSWER', 'WRONG_NUMBER', 'MESSAGE_SENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactParty" AS ENUM ('GUARDIAN_LINK', 'REGISTER_GUARDIAN', 'STUDENT', 'OTHER');

-- DropIndex

-- CreateTable
CREATE TABLE "StudentFollowUp" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "reason" "FollowUpReason" NOT NULL,
    "signalKey" TEXT,
    "note" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToUserId" TEXT,
    "dueOn" DATE,
    "openedBy" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closeReason" TEXT,
    "requestKey" TEXT NOT NULL,

    CONSTRAINT "StudentFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentContact" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "followUpId" TEXT,
    "party" "ContactParty" NOT NULL,
    "guardianLinkId" TEXT,
    "channel" "ContactChannel" NOT NULL,
    "outcome" "ContactOutcome" NOT NULL,
    "note" TEXT,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactedBy" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,

    CONSTRAINT "StudentContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyFollowUpSettings" (
    "academyId" TEXT NOT NULL,
    "absenceStreak" INTEGER NOT NULL DEFAULT 3,
    "lateStreak" INTEGER NOT NULL DEFAULT 3,
    "overdueDays" INTEGER NOT NULL DEFAULT 7,
    "guardianFeesVisible" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AcademyFollowUpSettings_pkey" PRIMARY KEY ("academyId")
);

-- CreateIndex
CREATE INDEX "StudentFollowUp_academyId_status_openedAt_idx" ON "StudentFollowUp"("academyId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "StudentFollowUp_academyStudentId_idx" ON "StudentFollowUp"("academyStudentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentFollowUp_academyId_requestKey_key" ON "StudentFollowUp"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "StudentContact_academyId_contactedAt_idx" ON "StudentContact"("academyId", "contactedAt");

-- CreateIndex
CREATE INDEX "StudentContact_academyStudentId_contactedAt_idx" ON "StudentContact"("academyStudentId", "contactedAt");

-- CreateIndex
CREATE INDEX "StudentContact_followUpId_idx" ON "StudentContact"("followUpId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentContact_academyId_requestKey_key" ON "StudentContact"("academyId", "requestKey");

-- AddForeignKey
ALTER TABLE "StudentFollowUp" ADD CONSTRAINT "StudentFollowUp_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFollowUp" ADD CONSTRAINT "StudentFollowUp_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentContact" ADD CONSTRAINT "StudentContact_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentContact" ADD CONSTRAINT "StudentContact_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentContact" ADD CONSTRAINT "StudentContact_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "StudentFollowUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentContact" ADD CONSTRAINT "StudentContact_guardianLinkId_fkey" FOREIGN KEY ("guardianLinkId") REFERENCES "GuardianLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyFollowUpSettings" ADD CONSTRAINT "AcademyFollowUpSettings_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- C5 guarantees the database keeps by itself (see docs/STUDENT-FOLLOW-UP.md).
-- ─────────────────────────────────────────────────────────────────────────────

-- Shapes and bounds.
ALTER TABLE "StudentFollowUp" ADD CONSTRAINT "StudentFollowUp_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND (("reason" = 'MANUAL') = ("signalKey" IS NULL))
  AND ("signalKey" IS NULL OR length("signalKey") BETWEEN 1 AND 200)
  AND ("note" IS NULL OR length("note") BETWEEN 1 AND 500)
  AND ("closeReason" IS NULL OR length("closeReason") BETWEEN 3 AND 300)
);
ALTER TABLE "StudentFollowUp" ADD CONSTRAINT "StudentFollowUp_closed_whole" CHECK (
  ("status" = 'OPEN' AND "closedAt" IS NULL AND "closedBy" IS NULL AND "closeReason" IS NULL)
  OR ("status" <> 'OPEN' AND "closedAt" IS NOT NULL AND "closedBy" IS NOT NULL AND "closeReason" IS NOT NULL)
);
ALTER TABLE "StudentContact" ADD CONSTRAINT "StudentContact_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND ("note" IS NULL OR length("note") BETWEEN 1 AND 500)
  AND (("party" = 'GUARDIAN_LINK') = ("guardianLinkId" IS NOT NULL))
);
ALTER TABLE "AcademyFollowUpSettings" ADD CONSTRAINT "AcademyFollowUpSettings_bounds" CHECK (
  "absenceStreak" BETWEEN 2 AND 10 AND "lateStreak" BETWEEN 2 AND 10 AND "overdueDays" BETWEEN 0 AND 90
);

-- One OPEN case per learner, reason and signal occurrence (derived cases).
CREATE UNIQUE INDEX "StudentFollowUp_open_once" ON "StudentFollowUp"("academyStudentId", "reason", "signalKey")
  WHERE "status" = 'OPEN' AND "signalKey" IS NOT NULL;

-- Nothing is ever deleted; a contact is never edited.
CREATE FUNCTION followup_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "StudentFollowUp_no_delete" BEFORE DELETE ON "StudentFollowUp"
  FOR EACH ROW EXECUTE FUNCTION followup_no_delete();
CREATE TRIGGER "StudentContact_no_delete" BEFORE DELETE ON "StudentContact"
  FOR EACH ROW EXECUTE FUNCTION followup_no_delete();

CREATE FUNCTION followup_contact_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'StudentContact is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "StudentContact_no_update" BEFORE UPDATE ON "StudentContact"
  FOR EACH ROW EXECUTE FUNCTION followup_contact_no_update();

-- A case: what it is about never changes; it closes once; a closed case is history.
CREATE FUNCTION followup_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."academyId" <> OLD."academyId" OR NEW."academyStudentId" <> OLD."academyStudentId"
     OR NEW."reason" <> OLD."reason" OR NEW."signalKey" IS DISTINCT FROM OLD."signalKey"
     OR NEW."note" IS DISTINCT FROM OLD."note" OR NEW."openedBy" <> OLD."openedBy"
     OR NEW."openedAt" <> OLD."openedAt" OR NEW."requestKey" <> OLD."requestKey" THEN
    RAISE EXCEPTION 'a follow-up case keeps what it is about' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'a closed follow-up case is history' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StudentFollowUp_guard" BEFORE UPDATE ON "StudentFollowUp"
  FOR EACH ROW EXECUTE FUNCTION followup_case_guard();

-- Tenant: a case or contact belongs to its learner's academy; a contact's case
-- is the same learner's; a contacted guardian link is this learner's, here.
CREATE FUNCTION followup_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s_academy text; s_profile text;
BEGIN
  SELECT "academyId", "studentId" INTO s_academy, s_profile FROM "AcademyStudent" WHERE id = NEW."academyStudentId";
  IF s_academy IS DISTINCT FROM NEW."academyId" THEN
    RAISE EXCEPTION 'follow-up crosses academies' USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'StudentContact' THEN
    IF NEW."followUpId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "StudentFollowUp" f WHERE f.id = NEW."followUpId"
        AND f."academyId" = NEW."academyId" AND f."academyStudentId" = NEW."academyStudentId") THEN
      RAISE EXCEPTION 'contact case belongs to another learner' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."guardianLinkId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "GuardianLink" g WHERE g.id = NEW."guardianLinkId"
        AND g."academyId" = NEW."academyId" AND g."studentId" = s_profile) THEN
      RAISE EXCEPTION 'contacted guardian belongs to another learner' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "StudentFollowUp_tenant" BEFORE INSERT ON "StudentFollowUp"
  FOR EACH ROW EXECUTE FUNCTION followup_tenant_guard();
CREATE TRIGGER "StudentContact_tenant" BEFORE INSERT ON "StudentContact"
  FOR EACH ROW EXECUTE FUNCTION followup_tenant_guard();
