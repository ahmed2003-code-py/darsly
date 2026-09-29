-- Live admission requests: a one-person capacity exception a teacher approves. Additive only.
-- CreateEnum
CREATE TYPE "LiveAdmissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'USED');

-- CreateTable
CREATE TABLE "LiveAdmissionRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "LiveAdmissionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "usedAt" TIMESTAMP(3),
    "bookingId" TEXT,
    "purchaseId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveAdmissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveAdmissionRequest_sessionId_status_idx" ON "LiveAdmissionRequest"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LiveAdmissionRequest_sessionId_userId_key" ON "LiveAdmissionRequest"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "LiveAdmissionRequest" ADD CONSTRAINT "LiveAdmissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

