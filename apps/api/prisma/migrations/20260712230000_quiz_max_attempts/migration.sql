-- Cap how many times a student may submit a quiz (null = unlimited).
-- Nullable column with no default → P3009-safe on non-empty tables. Idempotent.
ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER;
