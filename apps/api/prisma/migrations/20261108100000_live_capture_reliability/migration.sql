-- Transcript capture follows the teacher's intent (spans), one tab captures
-- (lease), and every piece the tab made is accounted for (manifest).
-- Additive only.

CREATE TABLE "LiveCaptureSpan" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "LiveCaptureSpan_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LiveCaptureSpan_sessionId_roomName_idx" ON "LiveCaptureSpan"("sessionId", "roomName");
ALTER TABLE "LiveCaptureSpan" ADD CONSTRAINT "LiveCaptureSpan_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LiveCaptureLease" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tabId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "audioOk" BOOLEAN NOT NULL DEFAULT true,
    "audioProblem" TEXT,
    "stats" JSONB,
    CONSTRAINT "LiveCaptureLease_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LiveCaptureLease_sessionId_roomName_releasedAt_idx" ON "LiveCaptureLease"("sessionId", "roomName", "releasedAt");
ALTER TABLE "LiveCaptureLease" ADD CONSTRAINT "LiveCaptureLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LiveAudioManifest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "leaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveAudioManifest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveAudioManifest_sessionId_roomName_seq_key" ON "LiveAudioManifest"("sessionId", "roomName", "seq");
ALTER TABLE "LiveAudioManifest" ADD CONSTRAINT "LiveAudioManifest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
