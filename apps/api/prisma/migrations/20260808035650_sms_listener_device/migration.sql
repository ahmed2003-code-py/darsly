-- CreateEnum
CREATE TYPE "SenderMatchType" AS ENUM ('EXACT', 'CONTAINS', 'REGEX');

-- CreateTable
CREATE TABLE "ListenerDevice" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "model" TEXT,
    "appVersion" TEXT,
    "refreshTokenHash" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListenerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderRule" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "matchType" "SenderMatchType" NOT NULL DEFAULT 'CONTAINS',
    "pattern" TEXT NOT NULL,
    "provider" "PaymentMethod" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "forwardToBackend" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SenderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSmsEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "messageHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "simSlot" INTEGER,
    "subscriptionId" INTEGER,
    "brand" TEXT,
    "provider" "PaymentMethod",
    "amountCents" INTEGER,
    "reference" TEXT,
    "forwarded" BOOLEAN NOT NULL DEFAULT false,
    "paymentEventId" TEXT,
    "matchStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSmsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListenerDevice_phone_revokedAt_idx" ON "ListenerDevice"("phone", "revokedAt");

-- CreateIndex
CREATE INDEX "SenderRule_enabled_priority_idx" ON "SenderRule"("enabled", "priority");

-- CreateIndex
CREATE INDEX "DeviceSmsEvent_deviceId_receivedAt_idx" ON "DeviceSmsEvent"("deviceId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSmsEvent_deviceId_messageHash_key" ON "DeviceSmsEvent"("deviceId", "messageHash");

-- AddForeignKey
ALTER TABLE "DeviceSmsEvent" ADD CONSTRAINT "DeviceSmsEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "ListenerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
