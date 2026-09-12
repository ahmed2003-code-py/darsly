-- A course can carry a short public intro clip, separate from lesson video.
-- Additive and guarded, so it is safe against a populated database.
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "introVideoUrl" TEXT;
ALTER TABLE "Course" ADD COLUMN IF NOT EXISTS "introVideoMediaId" TEXT;

-- The media kind that clip is stored under. Declared here and never used in
-- this migration, which is what lets ADD VALUE run inside the transaction
-- Prisma wraps migrations in.
ALTER TYPE "AcademyMediaKind" ADD VALUE IF NOT EXISTS 'COURSE_INTRO';
