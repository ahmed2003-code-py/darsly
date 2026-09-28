-- Messenger polish: voice notes as message assets, delete-for-everyone
-- tombstones, delete-for-me. Additive only; no existing row changes.

-- AlterEnum
ALTER TYPE "ChatAttachmentKind" ADD VALUE 'VOICE';

-- AlterTable
ALTER TABLE "ChatAttachment" ADD COLUMN     "durationSec" INTEGER;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT;

-- CreateTable
CREATE TABLE "ChatMessageHide" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageHide_pkey" PRIMARY KEY ("messageId","userId")
);

-- CreateIndex
CREATE INDEX "ChatMessageHide_userId_idx" ON "ChatMessageHide"("userId");

-- AddForeignKey
ALTER TABLE "ChatMessageHide" ADD CONSTRAINT "ChatMessageHide_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageHide" ADD CONSTRAINT "ChatMessageHide_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

