-- Architecture Reset, Phase 3. Additive only.

CREATE TABLE "AcademyInvitationLink" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "role" "AcademyRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcademyInvitationLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcademyInvitationLink_tokenHash_key" ON "AcademyInvitationLink"("tokenHash");
CREATE INDEX "AcademyInvitationLink_academyId_usedAt_idx" ON "AcademyInvitationLink"("academyId", "usedAt");
ALTER TABLE "AcademyInvitationLink" ADD CONSTRAINT "AcademyInvitationLink_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
