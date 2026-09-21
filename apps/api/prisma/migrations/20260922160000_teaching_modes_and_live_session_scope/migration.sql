-- Architecture Reset, Phase 5. Additive only; no existing column is renamed,
-- dropped or repointed; no rows are deleted.

CREATE TYPE "SessionMode" AS ENUM ('ONLINE', 'PHYSICAL', 'HYBRID');
CREATE TYPE "SessionLocationType" AS ENUM ('CENTER', 'TEACHER', 'STUDENT', 'OTHER');

-- GroupSession has only ever represented an in-person slot, so PHYSICAL is the
-- faithful value for every existing row. ONLINE/HYBRID are never invented here.
ALTER TABLE "GroupSession" ADD COLUMN "mode" "SessionMode" NOT NULL DEFAULT 'PHYSICAL';
ALTER TABLE "GroupSession" ADD COLUMN "locationType" "SessionLocationType";
ALTER TABLE "GroupSession" ADD COLUMN "locationNote" TEXT;
ALTER TABLE "GroupSession" ADD COLUMN "joinUrl" TEXT;
-- A slot booked into a Room is, by construction, at the Center.
UPDATE "GroupSession" SET "locationType" = 'CENTER' WHERE "roomId" IS NOT NULL AND "locationType" IS NULL;

-- LiveSession: organisation / teacher-user / group scope. tenantId (authorship)
-- is untouched. Backfill is deterministic: every existing stream belongs to its
-- author's PERSONAL workspace (Academy.id == TeacherProfile.id) and its
-- teacher is that profile's user. groupId has no reliable source and stays NULL.
ALTER TABLE "LiveSession" ADD COLUMN "academyId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "teacherUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "groupId" TEXT;
UPDATE "LiveSession" l SET "academyId" = l."tenantId"
  WHERE l."academyId" IS NULL AND EXISTS (SELECT 1 FROM "Academy" a WHERE a."id" = l."tenantId");
UPDATE "LiveSession" l SET "teacherUserId" = tp."userId"
  FROM "TeacherProfile" tp WHERE tp."id" = l."tenantId" AND l."teacherUserId" IS NULL;

CREATE INDEX "LiveSession_academyId_startsAt_idx" ON "LiveSession"("academyId", "startsAt");
CREATE INDEX "LiveSession_teacherUserId_startsAt_idx" ON "LiveSession"("teacherUserId", "startsAt");
CREATE INDEX "LiveSession_groupId_startsAt_idx" ON "LiveSession"("groupId", "startsAt");
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_teacherUserId_fkey" FOREIGN KEY ("teacherUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
