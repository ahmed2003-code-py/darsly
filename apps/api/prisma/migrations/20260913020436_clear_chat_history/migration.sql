-- Clearing a chat empties it, rather than hiding the conversation.
--
-- The first version put the thread away and brought the whole history back the
-- moment anyone wrote again, which is not what "clear" means to anybody. The
-- columns become a per-side starting line: from then on that person sees only
-- what was said after it. Renamed so the column says what it does.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ChatThread' AND column_name = 'hiddenForTeacherAt') THEN
    ALTER TABLE "ChatThread" RENAME COLUMN "hiddenForTeacherAt" TO "clearedForTeacherAt";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ChatThread' AND column_name = 'hiddenForStudentAt') THEN
    ALTER TABLE "ChatThread" RENAME COLUMN "hiddenForStudentAt" TO "clearedForStudentAt";
  END IF;
END
$$;

ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "clearedForTeacherAt" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "clearedForStudentAt" TIMESTAMP(3);
