-- Messaging Phase 0: one canonical conversation per pair, enforced by the database.
--
-- Until now "get or create" was a findFirst followed by a create with nothing
-- underneath it, so two first messages sent at the same moment could open two
-- conversations with the same person. From here the identity of a conversation
-- is one string, computed on the server and UNIQUE in the table:
--
--     <academyId>|<studentId>|S|U:<staffUserId>
--
-- For every conversation that exists today the academy is the teacher's own
-- workspace, whose id IS the teacher's tenantId (identity-preserving academy
-- migration), and the staff member is that teacher's user.
--
-- Written to be unable to fail at boot on production data (read-only check on
-- 2026-09-28: 5 threads, 8 messages, no duplicates, every tenantId an Academy).
-- The merge below still exists because dev/staging databases have duplicates
-- the old race produced; it moves messages and never deletes anything.

-- 1. Additive columns ─────────────────────────────────────────────────────────
ALTER TABLE "ChatThread"
  ADD COLUMN IF NOT EXISTS "academyId"     TEXT,
  ADD COLUMN IF NOT EXISTS "staffUserId"   TEXT,
  ADD COLUMN IF NOT EXISTS "dedupeKey"     TEXT,
  ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastMessageId" TEXT;

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientMessageId" TEXT;

-- 2. Merge duplicate conversations of the same pair ───────────────────────────
-- Canonical = the plain DM (no lesson pinned to the thread), else the oldest;
-- ties broken by id so the choice is deterministic. Only live (not soft-
-- deleted) threads take part: moving messages out of a hidden thread would
-- bring back history someone deliberately removed.
--
-- A thread that was pinned to a lesson hands that lesson to each of its
-- messages that had none — the context moves from the room to the message,
-- which is where the app already keeps it — but only when the lesson still
-- exists, since ChatMessage.lessonId is a foreign key.
--
-- Each side's "cleared" line on the canonical thread becomes the earliest line
-- among the merged copies (or none, if any copy was uncleared), so nothing that
-- was visible to someone in any copy disappears. The emptied extras are kept.
DO $$
DECLARE
  g     RECORD;
  canon TEXT;
BEGIN
  FOR g IN
    SELECT "tenantId", "studentId"
    FROM "ChatThread"
    WHERE "deletedAt" IS NULL
    GROUP BY "tenantId", "studentId"
    HAVING count(*) > 1
  LOOP
    SELECT id INTO canon
    FROM "ChatThread"
    WHERE "tenantId" = g."tenantId" AND "studentId" = g."studentId" AND "deletedAt" IS NULL
    ORDER BY (type = 'DM' AND "lessonId" IS NULL) DESC, "createdAt" ASC, id ASC
    LIMIT 1;

    UPDATE "ChatMessage" m
    SET "threadId" = canon,
        "lessonId" = COALESCE(m."lessonId", (SELECT l.id FROM "Lesson" l WHERE l.id = t."lessonId")),
        "videoTimestampSec" = CASE
          WHEN m."lessonId" IS NULL AND EXISTS (SELECT 1 FROM "Lesson" l WHERE l.id = t."lessonId")
            THEN t."videoTimestampSec"
          ELSE m."videoTimestampSec"
        END
    FROM "ChatThread" t
    WHERE m."threadId" = t.id
      AND t.id <> canon
      AND t."tenantId" = g."tenantId"
      AND t."studentId" = g."studentId"
      AND t."deletedAt" IS NULL;

    UPDATE "ChatThread" c
    SET "clearedForTeacherAt" = agg.teacher_at,
        "clearedForStudentAt" = agg.student_at
    FROM (
      SELECT
        CASE WHEN bool_or("clearedForTeacherAt" IS NULL) THEN NULL ELSE min("clearedForTeacherAt") END AS teacher_at,
        CASE WHEN bool_or("clearedForStudentAt" IS NULL) THEN NULL ELSE min("clearedForStudentAt") END AS student_at
      FROM "ChatThread"
      WHERE "tenantId" = g."tenantId" AND "studentId" = g."studentId" AND "deletedAt" IS NULL
    ) agg
    WHERE c.id = canon;
  END LOOP;
END $$;

-- 3. Backfill academy and staff member ────────────────────────────────────────
UPDATE "ChatThread" t
SET "academyId" = a.id
FROM "Academy" a
WHERE a.id = t."tenantId" AND t."academyId" IS NULL;

UPDATE "ChatThread" t
SET "staffUserId" = tp."userId"
FROM "TeacherProfile" tp
WHERE tp.id = t."tenantId" AND t."staffUserId" IS NULL;

-- 4. The identity key ─────────────────────────────────────────────────────────
-- One canonical key per pair: the same row the merge chose. Everything else —
-- emptied duplicates, soft-deleted threads, a thread whose teacher profile is
-- gone — gets a key that can never collide ('legacy:<id>'), so this UPDATE
-- cannot violate the unique index created below.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "tenantId", "studentId"
      ORDER BY ("deletedAt" IS NULL) DESC, (type = 'DM' AND "lessonId" IS NULL) DESC, "createdAt" ASC, id ASC
    ) AS rn
  FROM "ChatThread"
)
UPDATE "ChatThread" t
SET "dedupeKey" = CASE
  WHEN r.rn = 1 AND t."deletedAt" IS NULL AND t."staffUserId" IS NOT NULL
    THEN t."tenantId" || '|' || t."studentId" || '|S|U:' || t."staffUserId"
  ELSE 'legacy:' || t.id
END
FROM ranked r
WHERE r.id = t.id AND t."dedupeKey" IS NULL;

-- 5. Denormalised last message (the list sorts and pages on it) ───────────────
UPDATE "ChatThread" t
SET "lastMessageAt" = m."createdAt",
    "lastMessageId" = m.id
FROM (
  SELECT DISTINCT ON ("threadId") "threadId", id, "createdAt"
  FROM "ChatMessage"
  WHERE "deletedAt" IS NULL
  ORDER BY "threadId", "createdAt" DESC, id DESC
) m
WHERE m."threadId" = t.id;

-- 6. Constraints and indexes ──────────────────────────────────────────────────
ALTER TABLE "ChatThread" ALTER COLUMN "dedupeKey" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ChatThread_dedupeKey_key" ON "ChatThread"("dedupeKey");

-- Keyset pages over each side's conversation list.
CREATE INDEX IF NOT EXISTS "ChatThread_tenantId_lastMessageAt_id_idx"
  ON "ChatThread"("tenantId", "lastMessageAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "ChatThread_studentId_lastMessageAt_id_idx"
  ON "ChatThread"("studentId", "lastMessageAt" DESC, "id" DESC);

-- A retried send carries the same client id and must land once. NULLs are
-- distinct, so every message sent before this column existed is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_senderId_clientMessageId_key"
  ON "ChatMessage"("senderId", "clientMessageId");

-- Newest-first keyset pages within a conversation. Supersedes the two-column
-- index, whose every use this one also serves.
CREATE INDEX IF NOT EXISTS "ChatMessage_threadId_createdAt_id_idx"
  ON "ChatMessage"("threadId", "createdAt" DESC, "id" DESC);
DROP INDEX IF EXISTS "ChatMessage_threadId_createdAt_idx";
