-- Live hardening (Checkpoint A). Additive only: four nullable columns and two
-- indexes. No backfill, no NOT NULL, no default — existing rows read NULL,
-- which every code path treats as "not cancelled" / "not traced".

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiCallLog" ADD COLUMN     "aiJobId" TEXT,
ADD COLUMN     "liveSessionId" TEXT;

-- CreateIndex
CREATE INDEX "AiCallLog_liveSessionId_idx" ON "AiCallLog"("liveSessionId");

-- CreateIndex
CREATE INDEX "AiCallLog_aiJobId_idx" ON "AiCallLog"("aiJobId");

