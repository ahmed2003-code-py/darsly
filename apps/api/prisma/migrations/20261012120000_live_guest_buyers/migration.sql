-- Live Commerce E: buying a live seat without an account.
--
-- Additive. Payment.studentId becomes nullable ONLY for a guest's Live seat;
-- the CHECK below keeps every course payment (all existing rows) tied to a
-- student exactly as before.

-- AlterEnum (the new value is not used in this migration)
ALTER TYPE "Role" ADD VALUE 'GUEST';

-- AlterTable (the foreign key keeps ON DELETE RESTRICT, as before)
ALTER TABLE "Payment" ALTER COLUMN "studentId" DROP NOT NULL;

-- A course payment always has its student; only a Live seat's may not
-- (a guest buyer, named on the purchase).
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_student_unless_live_check" CHECK (
  "studentId" IS NOT NULL OR "livePurchaseId" IS NOT NULL
);

-- AlterTable
ALTER TABLE "LivePurchase" ADD COLUMN     "accessTokenHash" TEXT,
ADD COLUMN     "guestBuyerId" TEXT;

-- A purchase has exactly one buyer: a student or a guest.
ALTER TABLE "LivePurchase" DROP CONSTRAINT "LivePurchase_buyer_check";
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_buyer_check" CHECK (
  ("studentId" IS NOT NULL AND "guestBuyerId" IS NULL)
  OR ("studentId" IS NULL AND "guestBuyerId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "GuestBuyer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestBuyer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestBuyer_userId_key" ON "GuestBuyer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LivePurchase_accessTokenHash_key" ON "LivePurchase"("accessTokenHash");

-- AddForeignKey
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_guestBuyerId_fkey" FOREIGN KEY ("guestBuyerId") REFERENCES "GuestBuyer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestBuyer" ADD CONSTRAINT "GuestBuyer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
