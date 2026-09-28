-- Phase 1: assistant authorization foundation.
-- Additive only: new enum, nullable/defaulted columns, one new table. The one
-- data change turns every existing ASSISTANT's role defaults into an explicit
-- grant, because from this release an ASSISTANT holds exactly what is listed.

-- CreateEnum
CREATE TYPE "MembershipCourseScope" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "AcademyInvitationLink" ADD COLUMN     "grant" JSONB;

-- AlterTable
ALTER TABLE "AcademyMembership" ADD COLUMN     "courseScope" "MembershipCourseScope" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "directContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "AssignmentSubmission" ADD COLUMN     "gradedBy" TEXT;

-- CreateTable
CREATE TABLE "MembershipCourse" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipCourse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipCourse_academyId_courseId_idx" ON "MembershipCourse"("academyId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipCourse_membershipId_courseId_key" ON "MembershipCourse"("membershipId", "courseId");

-- AddForeignKey
ALTER TABLE "MembershipCourse" ADD CONSTRAINT "MembershipCourse_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "AcademyMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCourse" ADD CONSTRAINT "MembershipCourse_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: existing assistants keep exactly what the old role defaults gave
-- them (plus any overrides they already had) and keep every course (ALL, the
-- column default). Idempotent: DISTINCT over the union.
UPDATE "AcademyMembership" m
SET "permissions" = (
  SELECT COALESCE(jsonb_agg(DISTINCT x ORDER BY x), '[]'::jsonb)
  FROM (
    SELECT jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(m."permissions") = 'array' THEN m."permissions" ELSE '[]'::jsonb END
    ) AS x
    UNION
    SELECT unnest(ARRAY[
      'assessment.author', 'assessment.grade', 'student.manage', 'chat.moderate',
      'live.manage', 'group.manage', 'attendance.mark', 'schedule.manage',
      'student.view', 'progress.view'
    ]) AS x
  ) s
)
WHERE m."role" = 'ASSISTANT';
