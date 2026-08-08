-- CreateTable
CREATE TABLE "DeviceEnrollmentCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByDeviceId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEnrollmentCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceEnrollmentCode_expiresAt_consumedAt_idx" ON "DeviceEnrollmentCode"("expiresAt", "consumedAt");
