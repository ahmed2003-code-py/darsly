-- Checkpoint C: secure replay of live recordings, independent visibility for
-- recording / transcript / summary, transcription modes, transcript segments,
-- and the timestamps the recording timeline was missing.
-- Additive only: new enums, nullable or defaulted columns, one new table.
-- Safe with the previous release still running (it ignores the new columns).
-- CreateEnum
CREATE TYPE "LiveVisibility" AS ENUM ('PRIVATE', 'STUDENTS');

-- CreateEnum
CREATE TYPE "LiveTranscriptionMode" AS ENUM ('OFF', 'MANUAL', 'AUTO_WHEN_RECORDING');

-- AlterTable
ALTER TABLE "LiveAudioSegment" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "transcribedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LiveRecording" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "finalizeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finalizeStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "recordingVisibility" "LiveVisibility" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "summaryVisibility" "LiveVisibility" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "transcriptCaptureOffAt" TIMESTAMP(3),
ADD COLUMN     "transcriptCaptureOnAt" TIMESTAMP(3),
ADD COLUMN     "transcriptMeta" JSONB,
ADD COLUMN     "transcriptSegments" JSONB,
ADD COLUMN     "transcriptVisibility" "LiveVisibility" NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "transcriptionMode" "LiveTranscriptionMode" NOT NULL DEFAULT 'OFF';

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LiveReplaySession" (
    "id" TEXT NOT NULL,
    "watermarkId" TEXT NOT NULL,
    "liveSessionId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceSessionId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "LiveReplaySession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveReplaySession_watermarkId_key" ON "LiveReplaySession"("watermarkId");

-- CreateIndex
CREATE INDEX "LiveReplaySession_liveSessionId_startedAt_idx" ON "LiveReplaySession"("liveSessionId", "startedAt");

-- CreateIndex
CREATE INDEX "LiveReplaySession_userId_startedAt_idx" ON "LiveReplaySession"("userId", "startedAt");

-- AddForeignKey
ALTER TABLE "LiveReplaySession" ADD CONSTRAINT "LiveReplaySession_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the old single switch (summaryForStudents) covered the summary AND
-- the recording. Keep exactly that for existing sessions; the transcript was
-- never shown to students, so it stays PRIVATE.
UPDATE "LiveSession"
SET "summaryVisibility" = 'STUDENTS', "recordingVisibility" = 'STUDENTS'
WHERE "summaryForStudents" = true;