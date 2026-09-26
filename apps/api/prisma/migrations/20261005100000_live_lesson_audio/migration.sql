-- Checkpoint B.8: lesson audio captured in the teacher's browser, transcribed after class.
-- Additive: a new enum value and a new table.
-- AlterEnum
ALTER TYPE "AiJobType" ADD VALUE 'LIVE_TRANSCRIBE';

-- CreateTable
CREATE TABLE "LiveAudioSegment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveAudioSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveAudioSegment_sessionId_createdAt_idx" ON "LiveAudioSegment"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LiveAudioSegment_sessionId_roomName_seq_key" ON "LiveAudioSegment"("sessionId", "roomName", "seq");

-- AddForeignKey
ALTER TABLE "LiveAudioSegment" ADD CONSTRAINT "LiveAudioSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

