-- Unguessable certificate verification token (stops serial enumeration).
-- Additive & nullable → P3009-safe. Existing certificates are preserved and get a
-- backfilled random token, so no certificate is invalidated.
ALTER TABLE "Certificate" ADD COLUMN IF NOT EXISTS "verifyToken" TEXT;

-- Backfill a random token for every existing row. random() is evaluated per-row,
-- and md5 over (random || row id) yields a distinct 32-hex-char value per row; the
-- unique cuid "id" guarantees no two rows collide.
UPDATE "Certificate"
  SET "verifyToken" = md5(random()::text || "id" || clock_timestamp()::text)
  WHERE "verifyToken" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_verifyToken_key"
  ON "Certificate"("verifyToken");
