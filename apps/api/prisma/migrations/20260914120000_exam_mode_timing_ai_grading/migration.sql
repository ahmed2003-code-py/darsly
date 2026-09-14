-- Three things about a course's exam that the schema described and nothing
-- enforced, plus the one distinction the feature was missing.

-- ── What the exam is for ────────────────────────────────────────────────────
--
-- Naming a lesson as the course's exam meant one thing: the course is shut
-- until the student passes it. That is a placement test, and it is not what a
-- teacher writing their first course means by "the exam" — they mean the paper
-- at the end, about what was just studied.
--
-- So the two intentions are now separate, and FINAL is the default. Every
-- existing course is moved to FINAL deliberately: the previous migration
-- adopted any course's sole QUIZ lesson as its exam automatically, which
-- silently turned a final paper into a locked front door on courses whose
-- teacher never asked for one. A teacher who does want a placement test now
-- says so, and gets it.
DO $$ BEGIN
  CREATE TYPE "CourseExamMode" AS ENUM ('GATE', 'FINAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Course"
  ADD COLUMN IF NOT EXISTS "examMode" "CourseExamMode" NOT NULL DEFAULT 'FINAL';

-- ── A time limit that is actually a limit ───────────────────────────────────
--
-- `timeLimitSec` has always been stored. Nothing read it: no countdown, no
-- check on submission. It is now enforced against the attempt's own startedAt,
-- which means a timed paper opens an attempt row when the student starts it
-- rather than only when they send it.

-- ── Giving a student their attempts back ────────────────────────────────────
--
-- `maxAttempts` was never exposed to a teacher, which is the only reason it
-- never locked anybody out: on a gated course, a paying student who used their
-- last attempt without passing had no way into the course and nobody could give
-- them one. Voiding is that way — the attempts stay readable, and stop counting.
ALTER TABLE "QuizAttempt" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);

-- ── Marking written answers against the teacher's model answer ──────────────
--
-- Off by default, and it never marks an answer wrong on its own: whatever it
-- cannot judge goes to the teacher's queue exactly as it did before.
ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "aiGrading" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Quiz" ADD COLUMN IF NOT EXISTS "aiThresholdPct" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "QuizAttempt" ADD COLUMN IF NOT EXISTS "aiFeedback" JSONB;

-- Attempts are counted and time-checked per student per quiz, now with the
-- voided ones filtered out of both.
CREATE INDEX IF NOT EXISTS "QuizAttempt_quizId_studentId_voidedAt_idx"
  ON "QuizAttempt"("quizId", "studentId", "voidedAt");
