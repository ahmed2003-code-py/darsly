-- Live classroom: the session's microphone policy and per-run participant controls. Additive only.
-- CreateEnum
CREATE TYPE "LiveMicPolicy" AS ENUM ('RAISE_HAND', 'LISTEN_ONLY');

-- CreateEnum
CREATE TYPE "LiveMicControl" AS ENUM ('DEFAULT', 'BLOCKED');

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "micPolicy" "LiveMicPolicy" NOT NULL DEFAULT 'RAISE_HAND';

-- CreateTable
CREATE TABLE "LiveParticipantControl" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "mic" "LiveMicControl" NOT NULL DEFAULT 'DEFAULT',
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveParticipantControl_pkey" PRIMARY KEY ("sessionId","userId")
);

-- AddForeignKey
ALTER TABLE "LiveParticipantControl" ADD CONSTRAINT "LiveParticipantControl_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

