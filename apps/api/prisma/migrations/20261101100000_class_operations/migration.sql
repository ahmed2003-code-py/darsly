-- Center Operations C2 — physical timetable, class occurrences, attendance.
--
-- Additive except for two uniqueness rules that are REPLACED by narrower ones
-- (no row is updated or deleted, and every existing row satisfies the new
-- rules — see the checks at the end):
--
--   GroupMembership  unique (groupId, studentId)  →  unique among OPEN stints
--                    + no two stints of one student in one group overlap.
--                    A student who leaves and comes back gets a new row, so
--                    who was in the group on a past date stays answerable.
--   AttendanceSession unique (groupId, date)      →  unique among date-based
--                    (legacy) sheets only; an occurrence's sheet is unique by
--                    its groupSessionId, so one group's two classes on one day
--                    have two sheets.
--
-- New: GroupScheduleSlot (weekly timetable rule), occurrence identity on
-- GroupSession (slotId, occurrenceDate), class start, sheet closing, record
-- provenance/check-in time/makeup context, group seats/subject/year/grace, and
-- the academy's timezone + late grace.
--
-- The previous API keeps working against this schema: it never reads the new
-- columns, its membership writes (createMany … skipDuplicates) still converge
-- on the open-stint index, and its date-based attendance upsert is replaced in
-- the same release.

-- CreateEnum
CREATE TYPE "AttendanceMethod" AS ENUM ('MANUAL', 'AUTO');

-- DropIndex (replaced below by partial indexes)
DROP INDEX "AttendanceSession_groupId_date_key";

-- DropIndex (replaced below by the open-stint index + no-overlap constraint)
DROP INDEX "GroupMembership_groupId_studentId_key";

-- AlterTable
ALTER TABLE "Academy" ADD COLUMN     "lateGraceMin" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo';

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "checkedInAt" TIMESTAMP(3),
ADD COLUMN     "homeGroupId" TEXT,
ADD COLUMN     "makeupForSessionId" TEXT,
ADD COLUMN     "method" "AttendanceMethod" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "AttendanceSession" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedBy" TEXT,
ADD COLUMN     "groupSessionId" TEXT;

-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "gradeId" TEXT,
ADD COLUMN     "lateGraceMin" INTEGER,
ADD COLUMN     "subjectId" TEXT;

-- AlterTable
ALTER TABLE "GroupSession" ADD COLUMN     "customizedAt" TIMESTAMP(3),
ADD COLUMN     "occurrenceDate" DATE,
ADD COLUMN     "slotId" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "startedBy" TEXT;

-- CreateTable
CREATE TABLE "GroupScheduleSlot" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "roomId" TEXT,
    "teacherUserId" TEXT,
    "locationType" "SessionLocationType",
    "locationNote" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "generatedThrough" DATE,
    "requestKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GroupScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupScheduleSlot_groupId_idx" ON "GroupScheduleSlot"("groupId");

-- CreateIndex
CREATE INDEX "GroupScheduleSlot_academyId_generatedThrough_idx" ON "GroupScheduleSlot"("academyId", "generatedThrough");

-- CreateIndex
CREATE UNIQUE INDEX "GroupScheduleSlot_academyId_requestKey_key" ON "GroupScheduleSlot"("academyId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSession_groupSessionId_key" ON "AttendanceSession"("groupSessionId");

-- CreateIndex
CREATE INDEX "AttendanceSession_groupId_date_idx" ON "AttendanceSession"("groupId", "date");

-- CreateIndex
CREATE INDEX "GroupMembership_groupId_addedAt_idx" ON "GroupMembership"("groupId", "addedAt");

-- CreateIndex
CREATE INDEX "GroupSession_slotId_occurrenceDate_idx" ON "GroupSession"("slotId", "occurrenceDate");

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "GradeLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (NO ACTION: checked at the end of the statement, so an
-- academy's cascading delete still goes through, while deleting a class that
-- has a sheet on its own is refused)
ALTER TABLE "AttendanceSession" ADD CONSTRAINT "AttendanceSession_groupSessionId_fkey" FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_homeGroupId_fkey" FOREIGN KEY ("homeGroupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_makeupForSessionId_fkey" FOREIGN KEY ("makeupForSessionId") REFERENCES "GroupSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScheduleSlot" ADD CONSTRAINT "GroupScheduleSlot_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScheduleSlot" ADD CONSTRAINT "GroupScheduleSlot_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScheduleSlot" ADD CONSTRAINT "GroupScheduleSlot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupScheduleSlot" ADD CONSTRAINT "GroupScheduleSlot_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "GroupScheduleSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Rules Prisma's schema language cannot express. The application checks
-- first for a friendly error; these are the guarantee under concurrency.
-- ─────────────────────────────────────────────────────────────────────────

-- Membership history: at most one open stint per (group, student)…
CREATE UNIQUE INDEX "GroupMembership_open_stint_key"
  ON "GroupMembership" ("groupId", "studentId") WHERE "deletedAt" IS NULL;
-- …and no two stints of the same student in the same group overlap in time
-- (an open stint is [addedAt, ∞)). btree_gist is already installed by the
-- scheduling migration.
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_stints_no_overlap"
  EXCLUDE USING gist (
    "groupId" WITH =,
    "studentId" WITH =,
    tsrange("addedAt", "deletedAt") WITH &&
  );
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_stint_order"
  CHECK ("deletedAt" IS NULL OR "deletedAt" >= "addedAt");

-- Date-based (pre-C2) sheets stay one per group per date.
CREATE UNIQUE INDEX "AttendanceSession_legacy_group_date_key"
  ON "AttendanceSession" ("groupId", "date") WHERE "groupSessionId" IS NULL;

-- One occurrence per slot per local date. Undeleted rows only: a CANCELLED
-- occurrence keeps its key (the generator can never recreate it), while an
-- untouched future occurrence removed by a slot edit gives its key back.
CREATE UNIQUE INDEX "GroupSession_slot_occurrence_key"
  ON "GroupSession" ("slotId", "occurrenceDate")
  WHERE "slotId" IS NOT NULL AND "deletedAt" IS NULL;
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_occurrence_pair"
  CHECK (("slotId" IS NULL) = ("occurrenceDate" IS NULL));

CREATE INDEX "AttendanceRecord_makeupForSessionId_idx" ON "AttendanceRecord" ("makeupForSessionId")
  WHERE "makeupForSessionId" IS NOT NULL;
CREATE INDEX "AttendanceRecord_homeGroupId_idx" ON "AttendanceRecord" ("homeGroupId")
  WHERE "homeGroupId" IS NOT NULL;

-- Value ranges.
ALTER TABLE "Academy" ADD CONSTRAINT "Academy_late_grace_range"
  CHECK ("lateGraceMin" BETWEEN 0 AND 120);
ALTER TABLE "Academy" ADD CONSTRAINT "Academy_timezone_present"
  CHECK (length("timezone") BETWEEN 1 AND 64);
ALTER TABLE "Group" ADD CONSTRAINT "Group_capacity_range"
  CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 1000);
ALTER TABLE "Group" ADD CONSTRAINT "Group_late_grace_range"
  CHECK ("lateGraceMin" IS NULL OR "lateGraceMin" BETWEEN 0 AND 120);
ALTER TABLE "GroupScheduleSlot" ADD CONSTRAINT "GroupScheduleSlot_shape"
  CHECK (
    "weekday" BETWEEN 0 AND 6
    AND "startMinute" BETWEEN 0 AND 1439
    AND "durationMin" BETWEEN 15 AND 600
    AND ("validTo" IS NULL OR "validTo" >= "validFrom")
    AND ("roomId" IS NULL OR "locationType" = 'CENTER')
  );
-- Closing writes AUTO absences only; a person changing one makes it MANUAL.
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_auto_is_absent"
  CHECK ("method" <> 'AUTO' OR "status" = 'ABSENT');
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_makeup_has_home"
  CHECK ("makeupForSessionId" IS NULL OR "homeGroupId" IS NOT NULL);

-- Tenant consistency the foreign keys alone do not give: a slot belongs to
-- its group's academy, and an occurrence's sheet to that occurrence's group
-- and academy. A bug that crossed academies fails here, not silently.
CREATE FUNCTION class_ops_slot_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = NEW."groupId" AND g."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'GroupScheduleSlot % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."roomId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Room" r WHERE r.id = NEW."roomId" AND r."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'GroupScheduleSlot % room crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GroupScheduleSlot_tenant"
  BEFORE INSERT OR UPDATE OF "academyId", "groupId", "roomId" ON "GroupScheduleSlot"
  FOR EACH ROW EXECUTE FUNCTION class_ops_slot_tenant();

CREATE FUNCTION class_ops_sheet_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."groupSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "GroupSession" s
    WHERE s.id = NEW."groupSessionId" AND s."groupId" = NEW."groupId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'AttendanceSession % does not match its occurrence', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AttendanceSession_tenant"
  BEFORE INSERT OR UPDATE OF "groupSessionId", "groupId", "academyId" ON "AttendanceSession"
  FOR EACH ROW EXECUTE FUNCTION class_ops_sheet_tenant();

CREATE FUNCTION class_ops_record_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AttendanceSession" s WHERE s.id = NEW."sessionId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'AttendanceRecord % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."homeGroupId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Group" g WHERE g.id = NEW."homeGroupId" AND g."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'AttendanceRecord % home group crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."makeupForSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "GroupSession" s WHERE s.id = NEW."makeupForSessionId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'AttendanceRecord % makeup crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AttendanceRecord_tenant"
  BEFORE INSERT OR UPDATE OF "sessionId", "academyId", "homeGroupId", "makeupForSessionId" ON "AttendanceRecord"
  FOR EACH ROW EXECUTE FUNCTION class_ops_record_tenant();
