-- Student Studio: a cosmetic catalogue, who owns what, and what they wear.
--
-- Additive only. Nothing existing is altered: XP, coins, levels, badges and
-- streaks stay exactly where they are and this builds on top of them.

DO $$ BEGIN
  CREATE TYPE "CosmeticCategory" AS ENUM
    ('THEME','ACCENT','BUTTON_STYLE','CARD_STYLE','NAV_STYLE','AVATAR','FRAME','EFFECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CosmeticRarity" AS ENUM ('COMMON','RARE','EPIC','LEGENDARY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CosmeticItem" (
  "id"                  TEXT NOT NULL,
  "key"                 TEXT NOT NULL,
  "category"            "CosmeticCategory" NOT NULL,
  "rarity"              "CosmeticRarity" NOT NULL DEFAULT 'COMMON',
  "nameAr"              TEXT NOT NULL,
  "nameEn"              TEXT NOT NULL,
  "descAr"              TEXT NOT NULL DEFAULT '',
  "descEn"              TEXT NOT NULL DEFAULT '',
  "config"              JSONB NOT NULL DEFAULT '{}',
  "costCoins"           INTEGER NOT NULL DEFAULT 0,
  "requiredLevel"       INTEGER NOT NULL DEFAULT 1,
  "requiredAchievement" TEXT,
  "isStarter"           BOOLEAN NOT NULL DEFAULT false,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CosmeticItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CosmeticItem_key_key" ON "CosmeticItem"("key");
CREATE INDEX IF NOT EXISTS "CosmeticItem_category_isActive_sortOrder_idx"
  ON "CosmeticItem"("category", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "CosmeticItem_isActive_sortOrder_idx"
  ON "CosmeticItem"("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "StudentCosmetic" (
  "id"        TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "source"    TEXT NOT NULL DEFAULT 'PURCHASE',
  "costCoins" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudentCosmetic_pkey" PRIMARY KEY ("id")
);
-- The constraint that makes buying the same item twice impossible, rather than
-- merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS "StudentCosmetic_studentId_itemId_key"
  ON "StudentCosmetic"("studentId", "itemId");
CREATE INDEX IF NOT EXISTS "StudentCosmetic_studentId_createdAt_idx"
  ON "StudentCosmetic"("studentId", "createdAt");

CREATE TABLE IF NOT EXISTS "StudentCustomization" (
  "id"        TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "themeKey"  TEXT,
  "accentKey" TEXT,
  "accentHex" TEXT,
  "buttonKey" TEXT,
  "cardKey"   TEXT,
  "navKey"    TEXT,
  "avatarKey" TEXT,
  "frameKey"  TEXT,
  "effectKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudentCustomization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "StudentCustomization_studentId_key"
  ON "StudentCustomization"("studentId");

DO $$ BEGIN
  ALTER TABLE "StudentCosmetic" ADD CONSTRAINT "StudentCosmetic_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StudentCosmetic" ADD CONSTRAINT "StudentCosmetic_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "CosmeticItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StudentCustomization" ADD CONSTRAINT "StudentCustomization_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
