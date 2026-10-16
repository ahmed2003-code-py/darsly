-- A sender's mute that keeps the track published (instant mute/unmute, as
-- in any call app). Additive: two columns, one nullable, one defaulted.
ALTER TABLE "LiveRtcTrack" ADD COLUMN "mutedAt" TIMESTAMP(3);
ALTER TABLE "LiveRtcTrack" ADD COLUMN "mutedMs" INTEGER NOT NULL DEFAULT 0;
