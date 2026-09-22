-- Index the foreign keys Postgres does not index for us.
--
-- Unlike MySQL, PostgreSQL creates no index for a foreign key column. That
-- costs twice: a filter on the column is a sequential scan, and — less
-- obviously — every DELETE of a *parent* row has to scan the whole child table
-- to enforce ON DELETE CASCADE. Deleting one teacher was scanning Announcement
-- end to end; deleting one lesson was scanning Attachment.
--
-- Only columns that are actually filtered or actually cascaded are listed. An
-- index nobody reads is a write cost on every insert, so this is deliberately
-- not "every FK in the schema".
--
-- Plain CREATE INDEX rather than CONCURRENTLY: Prisma runs a migration inside
-- one transaction and CONCURRENTLY cannot. These tables are small today; if
-- any of them grows past the point where a brief write lock matters, that
-- index should be created by hand outside the migration runner.

-- Filtered on every lesson render; cascade parent is Lesson.
CREATE INDEX IF NOT EXISTS "Attachment_lessonId_idx" ON "Attachment"("lessonId");

-- Every ownership check filters by it (uploads.controller.ts).
CREATE INDEX IF NOT EXISTS "VideoAsset_tenantId_idx" ON "VideoAsset"("tenantId");

-- Read on every quiz render — the hottest of these.
CREATE INDEX IF NOT EXISTS "QuizQuestion_quizId_idx" ON "QuizQuestion"("quizId");

-- Trailing halves of composite primary keys: the PK indexes the leading column
-- only, so the reverse lookup and the cascade from the other parent are unindexed.
CREATE INDEX IF NOT EXISTS "TeacherGrade_gradeId_idx" ON "TeacherGrade"("gradeId");
CREATE INDEX IF NOT EXISTS "StudentInterest_subjectId_idx" ON "StudentInterest"("subjectId");
CREATE INDEX IF NOT EXISTS "BundleItem_courseId_idx" ON "BundleItem"("courseId");

-- Tenant scoping, and the cascade from TeacherProfile.
CREATE INDEX IF NOT EXISTS "Announcement_tenantId_idx" ON "Announcement"("tenantId");

-- Both cascade parents.
CREATE INDEX IF NOT EXISTS "PayoutMethodSaved_academyId_idx" ON "PayoutMethodSaved"("academyId");
CREATE INDEX IF NOT EXISTS "PayoutMethodSaved_tenantId_idx" ON "PayoutMethodSaved"("tenantId");
