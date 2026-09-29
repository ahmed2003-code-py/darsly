-- Live archive: a chat sender-name snapshot, reconnect and raised-hand counters. Additive only.
-- AlterTable
ALTER TABLE "LiveAttendance" ADD COLUMN     "reconnects" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "LiveChatMessage" ADD COLUMN     "senderName" TEXT;

-- AlterTable
ALTER TABLE "LiveHand" ADD COLUMN     "raisedCount" INTEGER NOT NULL DEFAULT 0;

