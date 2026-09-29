-- Live classroom: the session's camera policy and per-run camera controls. Additive only;
-- SPEAKERS_ONLY (the default) is exactly the behaviour before this change.
-- CreateEnum
CREATE TYPE "LiveCameraPolicy" AS ENUM ('SPEAKERS_ONLY', 'OPTIONAL', 'EXPECTED', 'OFF');

-- CreateEnum
CREATE TYPE "LiveCameraControl" AS ENUM ('DEFAULT', 'EXEMPT', 'BLOCKED');

-- AlterTable
ALTER TABLE "LiveParticipantControl" ADD COLUMN     "camera" "LiveCameraControl" NOT NULL DEFAULT 'DEFAULT',
ADD COLUMN     "cameraReport" TEXT,
ADD COLUMN     "cameraReportAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "cameraPolicy" "LiveCameraPolicy" NOT NULL DEFAULT 'SPEAKERS_ONLY';

