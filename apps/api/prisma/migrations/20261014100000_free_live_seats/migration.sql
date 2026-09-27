-- A seat on a FREE live session, taken by a guest from the session's public
-- link, is recorded as a zero-price LivePurchase: it reuses the guest access
-- machinery (a GUEST identity scoped to one session, a hashed access secret,
-- seat counting, entry and replay checks) instead of a second one.
--
-- The amounts check required a positive base price, which is right for every
-- sold seat and wrong for a free one. It is relaxed for exactly one shape: a
-- base price of zero with every other amount zero too. A zero seat never has a
-- Payment, so it is never released, refunded or booked in the ledger.
-- Every existing row satisfies the new check (all have a positive base price).

ALTER TABLE "LivePurchase" DROP CONSTRAINT "LivePurchase_amounts_check";
ALTER TABLE "LivePurchase" ADD CONSTRAINT "LivePurchase_amounts_check" CHECK (
  "basePriceCents" >= 0
  AND "discountCents" >= 0 AND "discountCents" <= "basePriceCents"
  AND "feeCents" >= 0 AND "teacherCents" >= 0 AND "centerCents" >= 0
  AND "studentPaysCents" >= 0
  AND "studentPaysCents" = "feeCents" + "teacherCents" + "centerCents"
  AND (
    "basePriceCents" > 0
    OR ("feeCents" = 0 AND "teacherCents" = 0 AND "centerCents" = 0 AND "studentPaysCents" = 0)
  )
);
