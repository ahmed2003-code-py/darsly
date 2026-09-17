-- What the teacher awarded each written question.
--
-- Only the final percentage was kept, so a marked paper could not say what any
-- single answer had earned: not to the teacher rereading it, not to the student
-- asking why, and not to a regrade trying to recompute the paper. The mark was
-- made and then thrown away.
ALTER TABLE "QuizAttempt" ADD COLUMN "manualScores" JSONB;
