-- Messaging Phase 0B: attachments, reactions, read cursors, frozen sender identity.
--
-- Additive only: three new tables, two nullable columns, indexes. The two
-- backfills at the end fill the new columns/tables from data that already
-- exists and cannot fail on it (every write is guarded or conflict-safe).

-- Enums (guarded: re-running this file must not fail) ─────────────────────────
DO $$ BEGIN
  CREATE TYPE "ChatAttachmentKind" AS ENUM ('IMAGE', 'FILE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ChatAttachmentStatus" AS ENUM ('PENDING', 'ATTACHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "senderKind" TEXT,
ADD COLUMN IF NOT EXISTS "senderTitle" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatAttachment" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "threadId" TEXT,
    "targetKey" TEXT,
    "messageId" TEXT,
    "kind" "ChatAttachmentKind" NOT NULL,
    "status" "ChatAttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "previewKey" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ChatReadState" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("threadId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChatAttachment_storageKey_key" ON "ChatAttachment"("storageKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatAttachment_messageId_idx" ON "ChatAttachment"("messageId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatAttachment_uploaderId_createdAt_idx" ON "ChatAttachment"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatAttachment_status_createdAt_idx" ON "ChatAttachment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChatReaction_messageId_userId_key" ON "ChatReaction"("messageId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatReadState_userId_idx" ON "ChatReadState"("userId");

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill 1: who sent each existing message ──────────────────────────────────
-- Every conversation so far is a teacher in their own workspace (the thread's
-- staff member, who owns that academy) and a student.
UPDATE "ChatMessage" m
SET "senderKind" = CASE
  WHEN t."staffUserId" IS NOT NULL AND m."senderId" = t."staffUserId" THEN 'OWNER'
  WHEN m."senderId" = sp."userId" THEN 'STUDENT'
  WHEN u.role = 'SUPER_ADMIN' THEN 'ADMIN'
  WHEN u.role = 'TEACHER' THEN 'TEACHER'
  WHEN u.role = 'STUDENT' THEN 'STUDENT'
  ELSE NULL
END
FROM "ChatThread" t, "StudentProfile" sp, "User" u
WHERE t.id = m."threadId"
  AND sp.id = t."studentId"
  AND u.id = m."senderId"
  AND m."senderKind" IS NULL;

-- Backfill 2: read cursors from the legacy per-message readAt ────────────────
-- readAt was set on the OTHER side's messages when someone opened the
-- conversation, all at once — so for each participant, the newest message
-- they had read (not sent) is where their cursor stands.
INSERT INTO "ChatReadState" ("threadId", "userId", "lastReadAt", "updatedAt")
SELECT r.tid, r.uid, r.last, now()
FROM (
  SELECT m."threadId" AS tid, reader.uid, max(m."createdAt") AS last
  FROM "ChatMessage" m
  JOIN "ChatThread" t ON t.id = m."threadId"
  JOIN "StudentProfile" sp ON sp.id = t."studentId"
  CROSS JOIN LATERAL (VALUES (sp."userId"), (t."staffUserId")) AS reader(uid)
  WHERE m."readAt" IS NOT NULL
    AND m."deletedAt" IS NULL
    AND reader.uid IS NOT NULL
    AND m."senderId" <> reader.uid
  GROUP BY m."threadId", reader.uid
) r
JOIN "User" u ON u.id = r.uid
ON CONFLICT ("threadId", "userId")
DO UPDATE SET "lastReadAt" = GREATEST("ChatReadState"."lastReadAt", EXCLUDED."lastReadAt");
