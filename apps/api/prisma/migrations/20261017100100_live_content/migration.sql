-- Additive only: Live class → permanent course content (provenance, a frozen
-- notes snapshot, a short conversion claim, and an exam's transcript source).
-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "liveContent" JSONB,
ADD COLUMN     "sourceLiveSessionId" TEXT;

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "contentClaimUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaperImport" ADD COLUMN     "sourceLiveSessionId" TEXT,
ADD COLUMN     "sourceMeta" JSONB;

-- CreateIndex
CREATE INDEX "Lesson_sourceLiveSessionId_idx" ON "Lesson"("sourceLiveSessionId");

-- CreateIndex
CREATE INDEX "PaperImport_sourceLiveSessionId_idx" ON "PaperImport"("sourceLiveSessionId");

-- AddForeignKey
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_sourceLiveSessionId_fkey" FOREIGN KEY ("sourceLiveSessionId") REFERENCES "LiveSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

