-- CreateEnum
CREATE TYPE "AcademyEnrollmentMode" AS ENUM ('AUTOMATIC', 'MANUAL', 'DEMO');

-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('MANUAL_APPROVAL', 'DEMO');

-- AlterEnum
ALTER TYPE "EnrollmentStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "Academy" ADD COLUMN     "enrollmentMode" "AcademyEnrollmentMode" NOT NULL DEFAULT 'AUTOMATIC';

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "source" "EnrollmentSource";
