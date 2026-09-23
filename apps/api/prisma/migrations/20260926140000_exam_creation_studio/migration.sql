-- Exam Creation Studio: the second way into the same exam.
--
-- Entirely additive. The paper-import tables keep their names and every
-- existing row keeps its meaning: an import created before this migration is
-- kind = PAPER, stage = READY if it was already waiting for review, and
-- nothing about it behaves differently.
--
-- Enum values are added before the columns that use them, because a column
-- default naming a value the type does not have yet is an error, not a warning.

DO $$ BEGIN
  CREATE TYPE "ExamCreationKind" AS ENUM ('PAPER', 'CONTENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExamCreationStage" AS ENUM ('UPLOADED', 'READING', 'GENERATING', 'VALIDATING', 'READY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "PaperSourceKind" ADD VALUE IF NOT EXISTS 'MIXED';
ALTER TYPE "PaperImportStatus" ADD VALUE IF NOT EXISTS 'CONFIGURING';

ALTER TABLE "PaperImport"
  ADD COLUMN IF NOT EXISTS "kind" "ExamCreationKind" NOT NULL DEFAULT 'PAPER',
  ADD COLUMN IF NOT EXISTS "stage" "ExamCreationStage" NOT NULL DEFAULT 'UPLOADED',
  ADD COLUMN IF NOT EXISTS "spec" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "progressDone" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "progressTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "highAccuracy" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "escalatedChunks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "generationBatches" INTEGER NOT NULL DEFAULT 0;

-- An import that already reached review is finished reading; saying so keeps
-- the new progress UI honest about rows that predate it.
UPDATE "PaperImport"
   SET "stage" = 'READY'
 WHERE "status" IN ('REVIEW', 'COMPLETED') AND "stage" = 'UPLOADED';

-- The teacher's own file name, so a grounded question can name the file they
-- uploaded rather than the storage key we invented for it.
ALTER TABLE "PaperImportPage" ADD COLUMN IF NOT EXISTS "originalName" TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "ExamSourceChunk" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL DEFAULT '',
    "page" INTEGER,
    "tokensApprox" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSourceChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExamSourceChunk_importId_index_key" ON "ExamSourceChunk"("importId", "index");
CREATE INDEX IF NOT EXISTS "ExamSourceChunk_importId_idx" ON "ExamSourceChunk"("importId");

DO $$ BEGIN
  ALTER TABLE "ExamSourceChunk" ADD CONSTRAINT "ExamSourceChunk_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "PaperImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
