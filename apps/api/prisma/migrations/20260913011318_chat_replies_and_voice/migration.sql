-- Replies and voice notes. Additive and guarded; existing messages are
-- unaffected and keep working exactly as they did.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "audioKey" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "audioDurationSec" INTEGER;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "audioBytes" INTEGER;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "audioMimeType" TEXT;

CREATE INDEX IF NOT EXISTS "ChatMessage_replyToId_idx" ON "ChatMessage"("replyToId");

-- SET NULL rather than cascade: deleting a message must not take the answers to
-- it with it; the reply simply stops quoting something that is gone.
DO $$
BEGIN
  ALTER TABLE "ChatMessage"
    ADD CONSTRAINT "ChatMessage_replyToId_fkey"
    FOREIGN KEY ("replyToId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
