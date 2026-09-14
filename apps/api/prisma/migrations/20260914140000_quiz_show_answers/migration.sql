-- Whether a student sees the right answers once they are done with the paper.
--
-- On by default, which is what the platform already did: the review was shown
-- once the student passed or ran out of attempts. A teacher who reuses one paper
-- across intakes turns it off, and their students still see their score and
-- their own answers — just not the key.
ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "showAnswers" BOOLEAN NOT NULL DEFAULT true;
