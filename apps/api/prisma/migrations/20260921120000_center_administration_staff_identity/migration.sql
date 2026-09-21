-- Architecture Reset, Phase 2. Additive only.

-- STAFF: a non-learning, non-teaching identity whose authority is membership-only.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STAFF';

-- Classification of academies. Every existing row is a teacher's PERSONAL
-- workspace (id == TeacherProfile.id); nothing is converted to CENTER here.
CREATE TYPE "AcademyKind" AS ENUM ('PERSONAL', 'CENTER');
ALTER TABLE "Academy" ADD COLUMN "kind" "AcademyKind" NOT NULL DEFAULT 'PERSONAL';
UPDATE "Academy" SET "kind" = 'PERSONAL' WHERE "kind" IS NULL;
CREATE INDEX "Academy_kind_status_idx" ON "Academy"("kind", "status");

-- One-time Center Admin activation (hash at rest, single-use, expiring, revocable).
CREATE TABLE "AcademyActivationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcademyActivationToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyActivationToken_tokenHash_key" ON "AcademyActivationToken"("tokenHash");
CREATE INDEX "AcademyActivationToken_userId_usedAt_idx" ON "AcademyActivationToken"("userId", "usedAt");
CREATE INDEX "AcademyActivationToken_academyId_idx" ON "AcademyActivationToken"("academyId");
ALTER TABLE "AcademyActivationToken" ADD CONSTRAINT "AcademyActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AcademyActivationToken" ADD CONSTRAINT "AcademyActivationToken_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
