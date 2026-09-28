-- Phase 2: Student Care — TEAM (shared inbox) and GROUP (class) conversations, and guardians.
-- Additive: existing conversations become kind DIRECT (the default); two columns
-- (tenantId, studentId) become nullable because a GROUP chat has neither.

-- CreateEnum
CREATE TYPE "ChatThreadKind" AS ENUM ('DIRECT', 'TEAM', 'GROUP');

-- CreateEnum
CREATE TYPE "GroupChatMode" AS ENUM ('OPEN', 'ANNOUNCEMENTS');

-- CreateEnum
CREATE TYPE "GuardianLinkStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "GuardianRelationship" AS ENUM ('FATHER', 'MOTHER', 'GUARDIAN', 'OTHER');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'GUARDIAN';

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "assigneeUserId" TEXT,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "groupMode" "GroupChatMode",
ADD COLUMN     "guardianUserId" TEXT,
ADD COLUMN     "kind" "ChatThreadKind" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ALTER COLUMN "tenantId" DROP NOT NULL,
ALTER COLUMN "studentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Guardian" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianLink" (
    "id" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "relationship" "GuardianRelationship" NOT NULL DEFAULT 'GUARDIAN',
    "status" "GuardianLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "GuardianLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianAccessToken" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardianAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guardian_userId_key" ON "Guardian"("userId");

-- CreateIndex
CREATE INDEX "GuardianLink_studentId_academyId_idx" ON "GuardianLink"("studentId", "academyId");

-- CreateIndex
CREATE INDEX "GuardianLink_academyId_status_idx" ON "GuardianLink"("academyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianLink_guardianId_studentId_academyId_key" ON "GuardianLink"("guardianId", "studentId", "academyId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardianAccessToken_tokenHash_key" ON "GuardianAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "GuardianAccessToken_linkId_idx" ON "GuardianAccessToken"("linkId");

-- CreateIndex
CREATE INDEX "ChatThread_academyId_kind_lastMessageAt_id_idx" ON "ChatThread"("academyId", "kind", "lastMessageAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ChatThread_guardianUserId_lastMessageAt_idx" ON "ChatThread"("guardianUserId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "ChatThread_groupId_idx" ON "ChatThread"("groupId");

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_guardianId_fkey" FOREIGN KEY ("guardianId") REFERENCES "Guardian"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianLink" ADD CONSTRAINT "GuardianLink_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianAccessToken" ADD CONSTRAINT "GuardianAccessToken_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "GuardianLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One class chat per Group, held by the database (not representable in the
-- Prisma DSL — same convention as AcademyMembership's isHome partial index).
-- The deterministic dedupeKey "<academy>|GROUP:<group>" already makes two
-- concurrent enables resolve to one row; this states the rule itself.
CREATE UNIQUE INDEX "ChatThread_one_group_chat" ON "ChatThread"("groupId") WHERE "kind" = 'GROUP';
