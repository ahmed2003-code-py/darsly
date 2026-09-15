-- The classroom gets a memory: chat, a recording, a transcript and a summary.
--
-- Additive throughout. Every existing session arrives with all three pipeline
-- stages NOT_STARTED, which is exactly what they are — nothing was recorded,
-- nothing was transcribed, nothing was summarised — so no row needs correcting
-- and nothing that worked yesterday changes.

-- ── The pipeline's shape ────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "LivePipelineStatus" AS ENUM ('NOT_STARTED', 'PROCESSING', 'READY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The summary runs on the queue that already exists, rather than a second one.
ALTER TYPE "AiJobType" ADD VALUE IF NOT EXISTS 'LIVE_SUMMARY';

-- ── What happens to a session after it ends ─────────────────────────────────
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "recordingStatus"    "LivePipelineStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "recordingId"        TEXT;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "recordingStartedAt" TIMESTAMP(3);
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "recordingDuration"  INTEGER;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "transcriptStatus"   "LivePipelineStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "transcriptText"     TEXT;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "summaryStatus"      "LivePipelineStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "summary"            JSONB;
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "summaryError"       TEXT;
-- Off by default: a summary is the teacher's notes on their own lesson until
-- they have read it and decided to publish it.
ALTER TABLE "LiveSession" ADD COLUMN IF NOT EXISTS "summaryForStudents" BOOLEAN NOT NULL DEFAULT false;

-- ── The classroom's chat ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "LiveChatMessage" (
  "id"        TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveChatMessage_pkey" PRIMARY KEY ("id")
);

-- Read in one order only: this session's messages, oldest first.
CREATE INDEX IF NOT EXISTS "LiveChatMessage_sessionId_createdAt_idx" ON "LiveChatMessage"("sessionId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "LiveChatMessage"
    ADD CONSTRAINT "LiveChatMessage_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "LiveChatMessage"
    ADD CONSTRAINT "LiveChatMessage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
