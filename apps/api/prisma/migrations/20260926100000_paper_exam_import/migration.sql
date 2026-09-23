-- Paper exam import: the authoring stage that turns photographed paper into an
-- ordinary Quiz.
--
-- Entirely additive. Nothing existing is altered except AiJobType, which gains
-- one value — a new enum member is safe for readers that have not been
-- deployed yet because no row uses it until the new code enqueues one.
--
-- Written by hand rather than by `migrate dev` so the ordering is explicit:
-- the enum value first (it has to exist before any job can name it), then the
-- new enums, then the tables that use them.

ALTER TYPE "AiJobType" ADD VALUE IF NOT EXISTS 'PAPER_IMPORT';

DO $$ BEGIN
  CREATE TYPE "PaperSourceKind" AS ENUM ('IMAGES', 'PDF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaperImportStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'REVIEW', 'COMPLETED', 'FAILED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaperImportPageStatus" AS ENUM ('PENDING', 'EXTRACTED', 'ESCALATED', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PaperImport" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "sourceKind" "PaperSourceKind" NOT NULL,
    "status" "PaperImportStatus" NOT NULL DEFAULT 'UPLOADING',
    "title" TEXT NOT NULL DEFAULT '',
    "jobId" TEXT,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "escalatedPages" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "lessonId" TEXT,
    "courseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PaperImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaperImportPage" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "originalKey" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "renderKey" TEXT,
    "textKey" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "status" "PaperImportPageStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT,
    "escalationReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMillicents" INTEGER NOT NULL DEFAULT 0,
    "extracted" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaperImportPage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PaperImport_academyId_createdAt_idx" ON "PaperImport"("academyId", "createdAt");
CREATE INDEX IF NOT EXISTS "PaperImport_tenantId_status_idx" ON "PaperImport"("tenantId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "PaperImportPage_importId_pageNumber_key" ON "PaperImportPage"("importId", "pageNumber");
CREATE INDEX IF NOT EXISTS "PaperImportPage_importId_status_idx" ON "PaperImportPage"("importId", "status");

DO $$ BEGIN
  ALTER TABLE "PaperImport" ADD CONSTRAINT "PaperImport_academyId_fkey"
    FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaperImportPage" ADD CONSTRAINT "PaperImportPage_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "PaperImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
