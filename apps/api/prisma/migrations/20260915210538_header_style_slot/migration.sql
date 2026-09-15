-- The header becomes a slot of its own, like the sidebar, the buttons and the
-- cards: a student may buy a header shape and wear it over any theme.
--
-- Additive throughout. An enum value and a nullable column; nothing existing
-- is touched and nothing needs a default.
ALTER TYPE "CosmeticCategory" ADD VALUE IF NOT EXISTS 'HEADER_STYLE';
ALTER TABLE "StudentCustomization" ADD COLUMN IF NOT EXISTS "headerKey" TEXT;
