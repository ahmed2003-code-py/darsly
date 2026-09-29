-- Speaker-attributed transcript: whose microphone each audio piece is. Additive only;
-- historical pieces keep null (no speaker invented).
-- AlterTable
ALTER TABLE "LiveAudioSegment" ADD COLUMN     "speakerKind" TEXT,
ADD COLUMN     "speakerName" TEXT,
ADD COLUMN     "speakerUserId" TEXT;

