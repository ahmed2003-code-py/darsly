-- Checkpoint B.7: recording stage timestamps (observability). Additive, nullable.
ALTER TABLE "LiveRecording" ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "captureStartedAt" TIMESTAMP(3),
ADD COLUMN "handedAt" TIMESTAMP(3),
ADD COLUMN "readyAt" TIMESTAMP(3);
