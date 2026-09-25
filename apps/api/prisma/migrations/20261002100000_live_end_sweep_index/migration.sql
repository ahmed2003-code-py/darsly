-- The end sweep's lookup (LiveService.overdueLiveSessionIds): LIVE classes
-- that have started. Additive: one index, no column, no data change.

-- CreateIndex
CREATE INDEX "LiveSession_status_startsAt_idx" ON "LiveSession"("status", "startsAt");

