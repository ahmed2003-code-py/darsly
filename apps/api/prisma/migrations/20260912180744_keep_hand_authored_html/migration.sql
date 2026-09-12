-- Handing a hand-authored page to the studio overwrote it with compiled markup
-- and left no way back. The original is kept here so the handover is a choice
-- that can be undone rather than a door that locks behind you.
ALTER TABLE "AcademySite" ADD COLUMN IF NOT EXISTS "handAuthoredHtml" TEXT;
