-- AlterTable
ALTER TABLE "LessonProgress" ADD COLUMN IF NOT EXISTS "watchedSec" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PlaybackSession" ADD COLUMN IF NOT EXISTS "lastBeatAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastPosSec" INTEGER NOT NULL DEFAULT 0;


-- Backfill from what the old rows already prove about real watching.
--
-- Both signals are evidence and neither can be forged retroactively, so take
-- whichever is kinder: the furthest position reached, or the percentage the old
-- (session-capped) logic managed to record. A student sitting at 200s of a 201s
-- lesson watched it — the previous rule simply had no way to say so, and capped
-- them at 22%.
--
-- Deliberately not marking anything complete here: the next heartbeat on the
-- lesson will do that through the normal path, which is also what awards the
-- XP, checks the unit and issues the certificate. A migration that sets
-- completedAt directly would grant the completion and silently skip all three.
UPDATE "LessonProgress" lp
SET "watchedSec" = GREATEST(
      lp."lastPositionSec",
      (lp."watchedPct" * COALESCE(NULLIF(l."durationSec", 0), va."durationSec", 0)) / 100
    )
FROM "Lesson" l
LEFT JOIN "VideoAsset" va ON va."id" = l."videoAssetId"
WHERE lp."lessonId" = l."id" AND lp."watchedSec" = 0;
