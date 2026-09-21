-- Architecture Reset, Phase 4. Additive only. tenantId (authorship) is untouched.
-- academyId (organisation scope) is added nullable and backfilled = tenantId,
-- which is exactly true for every existing row: every Academy.id equals its
-- teacher's TeacherProfile.id (identity-preserving provisioning), and no
-- CENTER-kind course/enrollment/payment can exist before this migration.

ALTER TABLE "Course" ADD COLUMN "academyId" TEXT;
ALTER TABLE "Enrollment" ADD COLUMN "academyId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "academyId" TEXT;

-- Backfill only where the tenant really is an Academy (always, today). A row
-- whose tenantId has no Academy is left NULL and surfaced by the integrity
-- check rather than guessed.
UPDATE "Course" c SET "academyId" = c."tenantId"
  WHERE c."academyId" IS NULL AND EXISTS (SELECT 1 FROM "Academy" a WHERE a."id" = c."tenantId");
UPDATE "Enrollment" e SET "academyId" = c."academyId"
  FROM "Course" c WHERE e."courseId" = c."id" AND e."academyId" IS NULL AND c."academyId" IS NOT NULL;
UPDATE "Payment" p SET "academyId" = c."academyId"
  FROM "Course" c WHERE p."courseId" = c."id" AND p."academyId" IS NULL AND c."academyId" IS NOT NULL;

CREATE INDEX "Course_academyId_status_idx" ON "Course"("academyId", "status");
CREATE INDEX "Enrollment_academyId_status_idx" ON "Enrollment"("academyId", "status");
CREATE INDEX "Payment_academyId_status_createdAt_idx" ON "Payment"("academyId", "status", "createdAt");
ALTER TABLE "Course" ADD CONSTRAINT "Course_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Center subject activation (opt-in; a missing row means "not offered").
CREATE TABLE "AcademySubject" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcademySubject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademySubject_academyId_subjectId_key" ON "AcademySubject"("academyId", "subjectId");
CREATE INDEX "AcademySubject_academyId_isActive_idx" ON "AcademySubject"("academyId", "isActive");
ALTER TABLE "AcademySubject" ADD CONSTRAINT "AcademySubject_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademySubject" ADD CONSTRAINT "AcademySubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
