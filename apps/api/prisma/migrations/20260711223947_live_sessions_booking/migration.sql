/*
  Warnings:

  - Added the required column `updatedAt` to the `LiveSession` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "LiveSession" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "durationMin" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "LiveBooking" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveBooking_studentId_idx" ON "LiveBooking"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveBooking_sessionId_studentId_key" ON "LiveBooking"("sessionId", "studentId");

-- AddForeignKey
ALTER TABLE "LiveBooking" ADD CONSTRAINT "LiveBooking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveBooking" ADD CONSTRAINT "LiveBooking_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
