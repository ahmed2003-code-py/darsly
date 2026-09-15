-- A scheduled live session becomes a real classroom.
--
-- Everything here is additive. Sessions that already exist keep their rows, keep
-- their `joinUrl`, and arrive as SCHEDULED — which is what they were. A teacher
-- who has been pasting a Zoom link goes on pasting a Zoom link until they press
-- Start, so nothing that worked yesterday stops working today.

-- ── The lifecycle ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LiveSessionStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── The session's own room ──────────────────────────────────────────────────
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "status" "LiveSessionStatus" NOT NULL DEFAULT 'SCHEDULED';
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "roomName" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "roomUrl" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3);

-- A room belongs to exactly one session. NULLs coexist freely under a unique
-- index in Postgres, which is what every session scheduled before today is.
CREATE UNIQUE INDEX IF NOT EXISTS "LiveSession_roomName_key" ON "LiveSession"("roomName");
CREATE INDEX IF NOT EXISTS "LiveSession_tenantId_status_idx" ON "LiveSession"("tenantId", "status");

-- Sessions whose window closed before this feature existed are finished, and
-- calling them SCHEDULED would put a "Start" button on a class from last month.
UPDATE "LiveSession"
   SET "status" = 'ENDED'
 WHERE "startsAt" + ("durationMin" || ' minutes')::interval < now();

-- ── Who was actually in the room ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LiveAttendance" (
  "id"              TEXT NOT NULL,
  "sessionId"       TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "role"            "Role" NOT NULL,
  "joinedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"          TIMESTAMP(3),
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "LiveAttendance_pkey" PRIMARY KEY ("id")
);

-- One row per person per session: a refresh, a reconnect or a second tab
-- extends what is already there instead of creating a second attendance.
CREATE UNIQUE INDEX IF NOT EXISTS "LiveAttendance_sessionId_userId_key" ON "LiveAttendance"("sessionId", "userId");
CREATE INDEX IF NOT EXISTS "LiveAttendance_sessionId_idx" ON "LiveAttendance"("sessionId");
CREATE INDEX IF NOT EXISTS "LiveAttendance_userId_idx" ON "LiveAttendance"("userId");

DO $$ BEGIN
  ALTER TABLE "LiveAttendance"
    ADD CONSTRAINT "LiveAttendance_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "LiveAttendance"
    ADD CONSTRAINT "LiveAttendance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
