-- Course purchases and wallet top-ups follow the Live payment flow: the
-- buyer declares where the money comes from BEFORE transferring, so a
-- durable PENDING row exists for the listener to match the moment the SMS
-- lands. The proof becomes supporting evidence instead of the thing that
-- creates the row.
--
-- Additive and backward compatible: new nullable columns, and the top-up
-- proof no longer required (every existing row keeps its proof). Old
-- clients that still send proof-first keep working unchanged.

-- AlterTable
ALTER TABLE "WalletTopup" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "payerName" TEXT,
ADD COLUMN     "transferSource" "TransferSource",
ALTER COLUMN "proofImageUrl" DROP NOT NULL;

-- Every existing top-up and course transfer payment was created WITH its
-- proof — already claimed. Say so, so none is mistaken for a declaration
-- still waiting for its transfer (which an expiry sweep may close).
UPDATE "WalletTopup" SET "claimedAt" = "createdAt" WHERE "claimedAt" IS NULL;
UPDATE "Payment" SET "claimedAt" = "createdAt"
WHERE "claimedAt" IS NULL
  AND "livePurchaseId" IS NULL
  AND "method" IS NOT NULL
  AND "method" NOT IN ('WALLET', 'CASH');
