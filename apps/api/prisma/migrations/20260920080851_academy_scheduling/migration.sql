-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GroupSessionStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "capacity" INTEGER,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupSession" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "teacherUserId" TEXT,
    "roomId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "GroupSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "GroupSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Room_academyId_status_idx" ON "Room"("academyId", "status");

-- CreateIndex
CREATE INDEX "GroupSession_academyId_startAt_idx" ON "GroupSession"("academyId", "startAt");

-- CreateIndex
CREATE INDEX "GroupSession_groupId_startAt_idx" ON "GroupSession"("groupId", "startAt");

-- CreateIndex
CREATE INDEX "GroupSession_roomId_startAt_idx" ON "GroupSession"("roomId", "startAt");

-- CreateIndex
CREATE INDEX "GroupSession_teacherUserId_startAt_idx" ON "GroupSession"("teacherUserId", "startAt");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Race-condition guarantee for concurrent scheduling requests. Application
-- code already pre-checks overlap for a friendly structured error, but only
-- a DB constraint can guarantee that two concurrent inserts/updates for the
-- same room or teacher can never BOTH succeed — this is that guarantee.
--
-- tsrange (not tstzrange): every DateTime column in this schema is a plain
-- TIMESTAMP(3) (no time zone), matching the project-wide convention of
-- storing UTC instants in timestamp-without-timezone columns (see
-- apps/api/src/gamification/period.util.ts).
--
-- Default range bounds are [start, end) — inclusive start, exclusive end —
-- which is exactly the required boundary rule: a session ending at 11:00
-- does not conflict with one starting at 11:00.
--
-- Each constraint is partial (WHERE ...): a CANCELLED or soft-deleted session
-- must not block a new booking over the same slot, and a session with no
-- room/teacher assigned yet has nothing to exclude on.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_room_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    tsrange("startAt", "endAt") WITH &&
  )
  WHERE ("roomId" IS NOT NULL AND "status" <> 'CANCELLED' AND "deletedAt" IS NULL);

ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_teacher_no_overlap"
  EXCLUDE USING gist (
    "teacherUserId" WITH =,
    tsrange("startAt", "endAt") WITH &&
  )
  WHERE ("teacherUserId" IS NOT NULL AND "status" <> 'CANCELLED' AND "deletedAt" IS NULL);

ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_group_no_overlap"
  EXCLUDE USING gist (
    "groupId" WITH =,
    tsrange("startAt", "endAt") WITH &&
  )
  WHERE ("status" <> 'CANCELLED' AND "deletedAt" IS NULL);
