-- What the worker is doing to a page while it reads it. Additive and nullable:
-- a page that never had one reads as "no detail", which is what every page
-- read before this was.
ALTER TABLE "PaperImportPage" ADD COLUMN IF NOT EXISTS "phase" TEXT;
ALTER TABLE "PaperImportPage" ADD COLUMN IF NOT EXISTS "phaseDone" INTEGER;
ALTER TABLE "PaperImportPage" ADD COLUMN IF NOT EXISTS "phaseTotal" INTEGER;
