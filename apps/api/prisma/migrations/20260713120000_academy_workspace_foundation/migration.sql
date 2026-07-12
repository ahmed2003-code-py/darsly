-- Academy (workspace) foundation — Phase 1. Purely additive: new tables only, no
-- changes to existing tables, so it is inherently P3009-safe. Idempotent guards
-- match the project's self-healing deploy (safe to re-run after a partial apply).

-- CreateEnum
DO $$ BEGIN CREATE TYPE "AcademyStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "AcademyRole" AS ENUM ('OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEFT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "FeeType" AS ENUM ('PERCENT', 'FIXED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Academy" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AcademyStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownerUserId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "coverUrl" TEXT,
    "colorPrimary" TEXT NOT NULL DEFAULT '#4A32C9',
    "colorAccent" TEXT NOT NULL DEFAULT '#4A32C9',
    "tagline" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "maxConcurrentSessions" INTEGER NOT NULL DEFAULT 2,
    "requiresEnrollmentApproval" BOOLEAN NOT NULL DEFAULT true,
    "feeType" "FeeType" NOT NULL DEFAULT 'PERCENT',
    "feeValue" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Academy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AcademyDomain" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AcademyMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "role" "AcademyRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "isHome" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "invitedBy" TEXT,
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Academy_slug_key" ON "Academy"("slug");
CREATE INDEX IF NOT EXISTS "Academy_status_idx" ON "Academy"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "AcademyDomain_hostname_key" ON "AcademyDomain"("hostname");
CREATE INDEX IF NOT EXISTS "AcademyDomain_academyId_idx" ON "AcademyDomain"("academyId");
CREATE INDEX IF NOT EXISTS "AcademyMembership_academyId_role_status_idx" ON "AcademyMembership"("academyId", "role", "status");
CREATE INDEX IF NOT EXISTS "AcademyMembership_userId_isHome_idx" ON "AcademyMembership"("userId", "isHome");
CREATE UNIQUE INDEX IF NOT EXISTS "AcademyMembership_userId_academyId_key" ON "AcademyMembership"("userId", "academyId");

-- AddForeignKey (guarded: ADD CONSTRAINT has no IF NOT EXISTS)
DO $$ BEGIN
  ALTER TABLE "Academy" ADD CONSTRAINT "Academy_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "AcademyDomain" ADD CONSTRAINT "AcademyDomain_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "AcademyMembership" ADD CONSTRAINT "AcademyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "AcademyMembership" ADD CONSTRAINT "AcademyMembership_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
