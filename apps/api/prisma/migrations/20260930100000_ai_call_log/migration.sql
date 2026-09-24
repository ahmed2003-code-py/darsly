-- One row per model call. Additive: a new table nothing else references.
CREATE TABLE IF NOT EXISTS "AiCallLog" (
  "id" TEXT NOT NULL,
  "importId" TEXT,
  "phase" TEXT,
  "stage" TEXT,
  "pageNumber" INTEGER,
  "region" TEXT,
  "batch" INTEGER,
  "attempt" INTEGER,
  "model" TEXT NOT NULL,
  "reasoningEffort" TEXT,
  "imageDetail" TEXT,
  "schemaName" TEXT,
  "imageCount" INTEGER NOT NULL DEFAULT 0,
  "maxOutputTokens" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "responseId" TEXT,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
  "priceInPerMToken" DOUBLE PRECISION,
  "priceOutPerMToken" DOUBLE PRECISION,
  "costMillicents" INTEGER NOT NULL DEFAULT 0,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiCallLog_importId_startedAt_idx" ON "AiCallLog"("importId", "startedAt");
CREATE INDEX IF NOT EXISTS "AiCallLog_createdAt_idx" ON "AiCallLog"("createdAt");
