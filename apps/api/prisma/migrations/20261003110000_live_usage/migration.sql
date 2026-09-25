-- Checkpoint B.6: per-class usage capture for Cloudflare classes (cost tracking).
-- Additive, nullable: existing rows are untouched.
ALTER TABLE "LiveSession" ADD COLUMN "usage" JSONB;
