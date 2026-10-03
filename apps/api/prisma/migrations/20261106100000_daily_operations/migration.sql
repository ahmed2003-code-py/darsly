-- CreateTable
CREATE TABLE "CenterDayClose" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "figures" JSONB NOT NULL,
    "exceptions" JSONB NOT NULL,
    "exceptionNote" TEXT,
    "reason" TEXT,
    "requestKey" TEXT NOT NULL,
    "closedBy" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CenterDayClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CenterDayClose_academyId_businessDate_idx" ON "CenterDayClose"("academyId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "CenterDayClose_academyId_businessDate_version_key" ON "CenterDayClose"("academyId", "businessDate", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CenterDayClose_academyId_requestKey_key" ON "CenterDayClose"("academyId", "requestKey");

-- AddForeignKey
ALTER TABLE "CenterDayClose" ADD CONSTRAINT "CenterDayClose_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateIndex (C7 reads reversals performed on a business day)
CREATE INDEX "CenterCollection_academyId_reversedAt_idx" ON "CenterCollection"("academyId", "reversedAt");

-- ── Center Operations C7 guards ─────────────────────────────────────────────
ALTER TABLE "CenterDayClose" ADD CONSTRAINT "CenterDayClose_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND "version" >= 1
  AND ("version" = 1 OR ("reason" IS NOT NULL AND char_length(btrim("reason")) BETWEEN 3 AND 300))
  AND ("exceptionNote" IS NULL OR char_length(btrim("exceptionNote")) BETWEEN 3 AND 500)
  AND jsonb_typeof("figures") = 'object'
  AND jsonb_typeof("exceptions") = 'array'
  AND (jsonb_array_length("exceptions") = 0 OR "exceptionNote" IS NOT NULL)
);

-- A close is history: never edited, never deleted. Re-closing adds a version.
CREATE FUNCTION center_day_close_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CenterDayClose is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "CenterDayClose_append_only" BEFORE UPDATE OR DELETE ON "CenterDayClose"
  FOR EACH ROW EXECUTE FUNCTION center_day_close_frozen();

-- Versions are gap-free per academy and day: N+1 only after N.
CREATE FUNCTION center_day_close_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."version" <> COALESCE((SELECT max("version") FROM "CenterDayClose"
       WHERE "academyId" = NEW."academyId" AND "businessDate" = NEW."businessDate"), 0) + 1 THEN
    RAISE EXCEPTION 'day close versions are consecutive' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CenterDayClose_sequence" BEFORE INSERT ON "CenterDayClose"
  FOR EACH ROW EXECUTE FUNCTION center_day_close_sequence();
