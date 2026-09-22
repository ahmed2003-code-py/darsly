-- Durable video packaging work.
--
-- Packaging was started with `void this.process(id).catch(log)`: nothing
-- recorded that the work was owed, so a crash or a Railway redeploy mid-ffmpeg
-- left the VideoAsset in PROCESSING forever with nothing to re-drive it.
-- This table is that record.
--
-- Additive throughout: one new table and two new enums. No existing table is
-- altered, so rolling the code back leaves an unused table and nothing else.

DO $$ BEGIN
  CREATE TYPE "VideoJobType" AS ENUM ('PACKAGE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "VideoJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "VideoJob" (
  "id"             TEXT NOT NULL,
  "videoAssetId"   TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "type"           "VideoJobType" NOT NULL DEFAULT 'PACKAGE',
  "status"         "VideoJobStatus" NOT NULL DEFAULT 'QUEUED',
  "input"          JSONB NOT NULL DEFAULT '{}',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "nextRunAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "errorClass"     TEXT,
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- The claim query reads exactly this: due, claimable, oldest first.
CREATE INDEX IF NOT EXISTS "VideoJob_status_nextRunAt_idx" ON "VideoJob"("status", "nextRunAt");
CREATE INDEX IF NOT EXISTS "VideoJob_videoAssetId_idx" ON "VideoJob"("videoAssetId");
CREATE INDEX IF NOT EXISTS "VideoJob_tenantId_createdAt_idx" ON "VideoJob"("tenantId", "createdAt");

-- One live job per asset, enforced by the database rather than by a read-then-write
-- in application code — which is exactly the check two concurrent uploads would
-- both pass. Partial, so a finished job never blocks a deliberate re-run: a new
-- job can be queued for an asset whose previous attempt SUCCEEDED, FAILED or was
-- CANCELED.
--
-- Written here rather than in schema.prisma because Prisma has no syntax for a
-- partial unique index. `prisma migrate dev` will report it as drift; this
-- project applies migrations with `migrate deploy`, which does not.
CREATE UNIQUE INDEX IF NOT EXISTS "VideoJob_active_per_asset_key"
  ON "VideoJob"("videoAssetId")
  WHERE "status" IN ('QUEUED', 'RUNNING');

DO $$ BEGIN
  ALTER TABLE "VideoJob"
    ADD CONSTRAINT "VideoJob_videoAssetId_fkey"
    FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
