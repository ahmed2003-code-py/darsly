-- CreateEnum
CREATE TYPE "AiJobType" AS ENUM ('SITE_GENERATE');

-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AcademySiteStatus" AS ENUM ('DRAFT', 'PENDING_MODERATION', 'PUBLISHED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AcademyMediaKind" AS ENUM ('LOGO', 'COVER', 'GALLERY', 'PROMO', 'AVATAR');

-- CreateEnum
CREATE TYPE "AcademyMediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'REJECTED');

-- CreateEnum
CREATE TYPE "AcademyClaimState" AS ENUM ('UNVERIFIED', 'ADMIN_VERIFIED', 'REJECTED');

-- CreateTable
CREATE TABLE "AcademyProfileFacts" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "fullName" TEXT,
    "bio" TEXT,
    "subjects" JSONB NOT NULL DEFAULT '[]',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "achievements" JSONB NOT NULL DEFAULT '[]',
    "socials" JSONB NOT NULL DEFAULT '[]',
    "rawIntake" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyProfileFacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademySite" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "status" "AcademySiteStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "draftDoc" JSONB,
    "publishedDoc" JSONB,
    "publishedHtml" TEXT,
    "moderationApproved" BOOLEAN NOT NULL DEFAULT false,
    "moderatedById" TEXT,
    "moderationReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademySite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademySiteSnapshot" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "doc" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademySiteSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyMedia" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "kind" "AcademyMediaKind" NOT NULL,
    "status" "AcademyMediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "storageKey" TEXT,
    "url" TEXT,
    "mimeType" TEXT,
    "bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "blurhash" TEXT,
    "contentHash" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiJob" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "type" "AiJobType" NOT NULL,
    "status" "AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL DEFAULT '{}',
    "stage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "errorClass" TEXT,
    "error" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "resultSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyClaim" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "state" "AcademyClaimState" NOT NULL DEFAULT 'UNVERIFIED',
    "evidenceMediaId" TEXT,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademyProfileFacts_academyId_key" ON "AcademyProfileFacts"("academyId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademySite_academyId_key" ON "AcademySite"("academyId");

-- CreateIndex
CREATE INDEX "AcademySite_status_idx" ON "AcademySite"("status");

-- CreateIndex
CREATE INDEX "AcademySiteSnapshot_siteId_createdAt_idx" ON "AcademySiteSnapshot"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "AcademyMedia_academyId_kind_idx" ON "AcademyMedia"("academyId", "kind");

-- CreateIndex
CREATE INDEX "AcademyMedia_academyId_status_idx" ON "AcademyMedia"("academyId", "status");

-- CreateIndex
CREATE INDEX "AcademyMedia_contentHash_idx" ON "AcademyMedia"("contentHash");

-- CreateIndex
CREATE INDEX "AiJob_status_createdAt_idx" ON "AiJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiJob_academyId_createdAt_idx" ON "AiJob"("academyId", "createdAt");

-- CreateIndex
CREATE INDEX "AcademyClaim_academyId_state_idx" ON "AcademyClaim"("academyId", "state");

-- AddForeignKey
ALTER TABLE "AcademyProfileFacts" ADD CONSTRAINT "AcademyProfileFacts_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademySite" ADD CONSTRAINT "AcademySite_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademySiteSnapshot" ADD CONSTRAINT "AcademySiteSnapshot_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "AcademySite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyMedia" ADD CONSTRAINT "AcademyMedia_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiJob" ADD CONSTRAINT "AiJob_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyClaim" ADD CONSTRAINT "AcademyClaim_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
