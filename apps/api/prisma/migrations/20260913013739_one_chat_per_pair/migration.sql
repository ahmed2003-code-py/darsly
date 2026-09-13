-- One conversation per teacher and student.
--
-- A question asked from inside a lesson opened its own thread, so a student who
-- had ever asked one saw two chats with the same teacher and no way to tell
-- them apart. The lesson is context for a message, not a room of its own: it
-- moves onto the message, and the threads it created are folded into the one
-- conversation that pair already had.

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "lessonId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "videoTimestampSec" INTEGER;
CREATE INDEX IF NOT EXISTS "ChatMessage_lessonId_idx" ON "ChatMessage"("lessonId");

-- SET NULL: deleting a lesson must not delete the questions asked about it.
DO $$
BEGIN
  ALTER TABLE "ChatMessage"
    ADD CONSTRAINT "ChatMessage_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- 1. Carry each Q&A thread's lesson down onto the messages in it.
UPDATE "ChatMessage" m
SET "lessonId" = t."lessonId", "videoTimestampSec" = t."videoTimestampSec"
FROM "ChatThread" t
WHERE m."threadId" = t.id
  AND t."type" = 'QA'
  AND m."lessonId" IS NULL;

-- 2. Every pair that only ever had a Q&A thread needs the one conversation to
--    fold into. The id is a random string because that column only needs to be
--    unique; Prisma's cuid default applies to rows Prisma itself creates.
INSERT INTO "ChatThread" (id, type, "tenantId", "studentId", "createdAt", "updatedAt")
SELECT
  md5(random()::text || clock_timestamp()::text || q."tenantId" || q."studentId"),
  'DM', q."tenantId", q."studentId", now(), now()
FROM (
  SELECT DISTINCT "tenantId", "studentId"
  FROM "ChatThread"
  WHERE "type" = 'QA' AND "deletedAt" IS NULL
) q
WHERE NOT EXISTS (
  SELECT 1 FROM "ChatThread" d
  WHERE d."tenantId" = q."tenantId"
    AND d."studentId" = q."studentId"
    AND d."type" = 'DM'
    AND d."deletedAt" IS NULL
);

-- 3. Move the messages into it. DISTINCT ON picks exactly one destination per
--    pair, so a pair that somehow has two DM threads cannot multiply rows.
UPDATE "ChatMessage" m
SET "threadId" = dest.id
FROM "ChatThread" q
JOIN (
  SELECT DISTINCT ON ("tenantId", "studentId") id, "tenantId", "studentId"
  FROM "ChatThread"
  WHERE "type" = 'DM' AND "deletedAt" IS NULL
  ORDER BY "tenantId", "studentId", "createdAt"
) dest ON dest."tenantId" = q."tenantId" AND dest."studentId" = q."studentId"
WHERE m."threadId" = q.id AND q."type" = 'QA';

-- 4. Float the conversations that just received messages back to the top.
UPDATE "ChatThread" t
SET "updatedAt" = GREATEST(t."updatedAt", m.latest)
FROM (SELECT "threadId", MAX("createdAt") AS latest FROM "ChatMessage" GROUP BY "threadId") m
WHERE m."threadId" = t.id;

-- 5. The emptied Q&A threads go. Nothing points at them any more.
DELETE FROM "ChatThread" WHERE "type" = 'QA';
