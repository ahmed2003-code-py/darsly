-- The old index named a column the course no longer has; the years it is
-- offered to are indexed on the join table instead.
DROP INDEX IF EXISTS "Course_subjectId_gradeId_status_idx";
CREATE INDEX IF NOT EXISTS "Course_subjectId_status_idx" ON "Course"("subjectId", "status");
