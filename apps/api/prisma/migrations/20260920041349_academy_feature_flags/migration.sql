-- CreateTable
CREATE TABLE "AcademyFeatureFlag" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AcademyFeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademyFeatureFlag_academyId_idx" ON "AcademyFeatureFlag"("academyId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyFeatureFlag_academyId_key_key" ON "AcademyFeatureFlag"("academyId", "key");

-- AddForeignKey
ALTER TABLE "AcademyFeatureFlag" ADD CONSTRAINT "AcademyFeatureFlag_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
