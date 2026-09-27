-- Additive only: every column is nullable or has a default; no row is rewritten.
ALTER TABLE "LiveSession"
  ADD COLUMN "summaryMeta" JSONB,
  ADD COLUMN "transcriptRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "transcriptLeaseJobId" TEXT,
  ADD COLUMN "transcriptLeaseUntil" TIMESTAMP(3);

ALTER TABLE "LiveAudioSegment"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skipReason" TEXT,
  ADD COLUMN "audioDeletedAt" TIMESTAMP(3);

ALTER TABLE "AiJob" ADD COLUMN "runAfter" TIMESTAMP(3);
