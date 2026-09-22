-- Which looks a Center is allowed to wear.
--
-- A theme is a namespaced id the platform resolves (preset:/academy:/cosmetic:),
-- not a row, so only the id is stored. Opt-in like "AcademySubject": no row means
-- not granted, so shipping this grants nothing to anybody and every existing
-- Center keeps the look it already has.
CREATE TABLE "AcademyThemeGrant" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyThemeGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcademyThemeGrant_academyId_themeId_key" ON "AcademyThemeGrant"("academyId", "themeId");
CREATE INDEX "AcademyThemeGrant_academyId_idx" ON "AcademyThemeGrant"("academyId");

ALTER TABLE "AcademyThemeGrant"
  ADD CONSTRAINT "AcademyThemeGrant_academyId_fkey"
  FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
