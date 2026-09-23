-- Work in progress, saved without being asked to.
--
-- Purely additive: one new table and one new enum, no column added to anything
-- that already exists and no foreign key into it. Nothing that runs today
-- reads this table, so applying it cannot change the behaviour of a single
-- existing request — which is the property that makes it safe to deploy
-- against a live database.

DO $$ BEGIN
  CREATE TYPE "ContentDraftKind" AS ENUM ('LESSON', 'ASSIGNMENT', 'QUIZ', 'COURSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ContentDraft" (
  "id"        TEXT NOT NULL,
  "academyId" TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "kind"      "ContentDraftKind" NOT NULL,
  "scopeKey"  TEXT NOT NULL,
  "courseId"  TEXT,
  "lessonId"  TEXT,
  "label"     TEXT NOT NULL DEFAULT '',
  "step"      TEXT NOT NULL DEFAULT '',
  "data"      JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

-- One draft per form per teacher. This is what turns an autosave firing every
-- few seconds into an update of one row rather than a new row each time.
CREATE UNIQUE INDEX IF NOT EXISTS "ContentDraft_tenantId_scopeKey_key"
  ON "ContentDraft" ("tenantId", "scopeKey");

CREATE INDEX IF NOT EXISTS "ContentDraft_tenantId_updatedAt_idx"
  ON "ContentDraft" ("tenantId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ContentDraft_courseId_updatedAt_idx"
  ON "ContentDraft" ("courseId", "updatedAt");
CREATE INDEX IF NOT EXISTS "ContentDraft_academyId_updatedAt_idx"
  ON "ContentDraft" ("academyId", "updatedAt");
