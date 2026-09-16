-- What the uploaded transfer receipt says, read from the image itself.
--
-- For InstaPay there is no shared reference: the number on the student's
-- receipt and the number in the bank's SMS are issued by different systems and
-- never agree. The amount and the minute the transfer was sent do agree, and
-- they are what links the two — so the receipt's contents have to be kept.
--
-- Nullable and with no default: every existing row simply has no reading, which
-- is the state they were already in.
ALTER TABLE "WalletTopup" ADD COLUMN "proofReading" JSONB;
ALTER TABLE "Payment" ADD COLUMN "proofReading" JSONB;
