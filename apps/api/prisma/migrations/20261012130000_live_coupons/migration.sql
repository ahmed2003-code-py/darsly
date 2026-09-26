-- Live Commerce F: coupons with an explicit scope.
--
-- Additive. Every existing coupon becomes COURSE (the column default) — which
-- is all any coupon could ever discount — so no existing coupon starts
-- applying to live seats. Course checkout reads only COURSE and ALL.

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('COURSE', 'LIVE', 'ALL');

-- AlterTable
ALTER TABLE "Coupon" ADD COLUMN     "liveSessionId" TEXT,
ADD COLUMN     "maxUsesPerStudent" INTEGER,
ADD COLUMN     "scope" "CouponScope" NOT NULL DEFAULT 'COURSE';

-- A coupon naming a course is a COURSE coupon; one naming a session is LIVE.
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_scope_target_check" CHECK (
  ("courseId" IS NULL OR "scope" = 'COURSE')
  AND ("liveSessionId" IS NULL OR "scope" = 'LIVE')
);
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_max_uses_per_student_check" CHECK (
  "maxUsesPerStudent" IS NULL OR "maxUsesPerStudent" > 0
);

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
