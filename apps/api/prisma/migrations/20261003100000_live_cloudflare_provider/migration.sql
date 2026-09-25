-- Checkpoint B.6: Cloudflare Realtime as a second live provider.
--
-- Additive only. The new LiveSession.provider column has a constant default,
-- so on PostgreSQL 11+ it is a catalogue change (no table rewrite) and every
-- existing row reads DAILY - which is what those classes ran on. The new
-- tables are empty until a Cloudflare class runs. Rolling the code back leaves
-- them unused and harmless.

-- CreateEnum
CREATE TYPE "LiveProviderKind" AS ENUM ('DAILY', 'CLOUDFLARE');

-- CreateEnum
CREATE TYPE "LiveRtcRole" AS ENUM ('TEACHER', 'STUDENT', 'RECORDER');

-- CreateEnum
CREATE TYPE "LiveRtcPurpose" AS ENUM ('RECEIVE', 'SEND');

-- CreateEnum
CREATE TYPE "LiveTrackKind" AS ENUM ('AUDIO', 'VIDEO', 'SCREEN', 'SCREEN_AUDIO');

-- CreateEnum
CREATE TYPE "LiveHandState" AS ENUM ('IDLE', 'HAND_RAISED', 'APPROVED_TO_SPEAK', 'ACTIVE_SPEAKER', 'RELEASED');

-- CreateEnum
CREATE TYPE "LiveRecordingStatus" AS ENUM ('REQUESTED', 'RECORDING', 'STOPPING', 'UPLOADING', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "provider" "LiveProviderKind" NOT NULL DEFAULT 'DAILY';

-- CreateTable
CREATE TABLE "LiveRtcConnection" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "LiveRtcRole" NOT NULL,
    "purpose" "LiveRtcPurpose" NOT NULL,
    "cfSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LiveRtcConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveRtcTrack" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LiveTrackKind" NOT NULL,
    "trackName" TEXT NOT NULL,
    "mid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "LiveRtcTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveHand" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "state" "LiveHandState" NOT NULL DEFAULT 'IDLE',
    "raisedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveHand_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateTable
CREATE TABLE "LiveRecording" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "LiveRecordingStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "stopRequestedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "segments" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "videoAssetId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveRecording_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveRtcConnection_cfSessionId_key" ON "LiveRtcConnection"("cfSessionId");

-- CreateIndex
CREATE INDEX "LiveRtcConnection_sessionId_roomName_closedAt_idx" ON "LiveRtcConnection"("sessionId", "roomName", "closedAt");

-- CreateIndex
CREATE INDEX "LiveRtcConnection_closedAt_createdAt_idx" ON "LiveRtcConnection"("closedAt", "createdAt");

-- CreateIndex
CREATE INDEX "LiveRtcTrack_sessionId_roomName_closedAt_idx" ON "LiveRtcTrack"("sessionId", "roomName", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LiveRtcTrack_connectionId_trackName_key" ON "LiveRtcTrack"("connectionId", "trackName");

-- CreateIndex
CREATE UNIQUE INDEX "LiveRecording_videoAssetId_key" ON "LiveRecording"("videoAssetId");

-- CreateIndex
CREATE INDEX "LiveRecording_status_leaseUntil_idx" ON "LiveRecording"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "LiveRecording_sessionId_createdAt_idx" ON "LiveRecording"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "LiveRtcConnection" ADD CONSTRAINT "LiveRtcConnection_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRtcTrack" ADD CONSTRAINT "LiveRtcTrack_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "LiveRtcConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRtcTrack" ADD CONSTRAINT "LiveRtcTrack_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveHand" ADD CONSTRAINT "LiveHand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveRecording" ADD CONSTRAINT "LiveRecording_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

