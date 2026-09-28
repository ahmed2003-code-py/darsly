-- What each exam source chunk came from: an uploaded file or a Live class's transcript.
ALTER TABLE "ExamSourceChunk" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'DOCUMENT';

-- Sessions written from a Live transcript already hold only transcript chunks.
UPDATE "ExamSourceChunk" SET "sourceKind" = 'LIVE_TRANSCRIPT'
WHERE "importId" IN (SELECT "id" FROM "PaperImport" WHERE "sourceKind" = 'TRANSCRIPT');
