-- Core subjects: the ones a Center is offering before anybody asks.
--
-- AcademySubject is opt-in, and it was opt-in for everything — so a brand new
-- Center could not file a course under Arabic until its owner had found the
-- subjects page and ticked it. The subjects every Egyptian school sits are not
-- a choice a Center makes; the rest still are.
--
-- Written to survive a non-empty table: the column has a default, and the
-- catalogue is keyed on `code`, so a subject an admin added by hand keeps its
-- own (false) answer.

ALTER TABLE "Subject" ADD COLUMN IF NOT EXISTS "isCore" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Subject" SET "isCore" = true
WHERE "code" IN ('arabic', 'religion', 'social', 'english', 'math-gen', 'science-gen', 'math-lang', 'science-lang');

-- Existing Centers are opted into the core set the same way a new one is. Only
-- where the Center has no row at all for that subject: an owner who has already
-- switched Arabic off meant it, and this must not switch it back on.
INSERT INTO "AcademySubject" ("id", "academyId", "subjectId", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."id", s."id", true, NOW(), NOW()
FROM "Academy" a
CROSS JOIN "Subject" s
WHERE a."kind" = 'CENTER' AND a."deletedAt" IS NULL AND s."isCore" = true AND s."isActive" = true
ON CONFLICT ("academyId", "subjectId") DO NOTHING;
