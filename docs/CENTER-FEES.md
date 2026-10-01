# Center Operations C4 — Center Fees, Dues, Collections & Receipts

What a learner owes **the center** and what the center **collected**: fee
plans for groups, monthly and per-class charges, one-time charges,
discounts and corrections, collections with receipts, reversals, a
statement, who owes what, and the day's collections. Shipped behind the
`centerFees` feature flag (default **off**, per academy, independent of
`studentRegistry` / `classOperations` / `receptionDesk`).

Code: `apps/api/src/center-fees/` (`CenterFeesService`, `FeePlansService`,
`CenterFeesController`, `CenterFeesWorker`, `money.ts`), migration
`20261103100000_center_fees`, web `apps/web/src/pages/fees/` and
`apps/web/src/lib/centerFees.ts`. Tests: `center-fees.integration.spec.ts`
(real Postgres), `money.spec.ts`, `center-fees.boundary.spec.ts`,
`apps/web/src/lib/centerFees.spec.ts`; browser E2E, responsive audit and
mutation run in `scripts/e2e/fees-*.{mjs,cjs}`.

## Center money is not platform money

**Platform money** is a sale of a Darsly product — a course, a Live seat, a
wallet top-up: a `Payment`, booked in the double-entry ledger
(`platform:cash`, `platform:commission`, academy/teacher balances), withdrawn
through `PayoutRequest`. Cash a Center takes **for a Darsly course** (Phase 7,
`payment.collect`) is still that.

**Center money (C4)** is the center's own tuition for its own physical
classes. Darsly is not a party: no commission, no ledger account, no payout,
no wallet. It lives only in `CenterFeePlan`, `CenterCharge`,
`CenterAdjustment`, `CenterCollection`, `CenterAllocation`,
`CenterReceiptCounter`.

How they are kept apart:

1. **Schema** — no foreign key from a C4 table to Payment / ledger / wallet /
   payouts / Live purchases, or back.
2. **Code** — `center-fees.boundary.spec.ts` fails the build if anything in
   `center-fees/` references a platform money model or module, or anything
   outside it touches a C4 model.
3. **Capabilities** — `fees.*`, never `payment.*`; the UI says "Center fees"
   and keeps Student 360's platform "Payments" tab separate.
4. **Flag** — `centerFees`, its own switch.
5. **Proof** — the integration suite and the browser E2E hash `Payment`,
   `PaymentEvent`, `LedgerTransaction`, `LedgerEntry`, `WalletTransaction`,
   `PayoutRequest`, `LivePurchase`, `CommercialTerms` before and after every
   C4 flow; production acceptance does the same.

## Money

Integer **minor units** (piasters for EGP: 500.00 EGP = `50000`), in the
academy's `currency` (`Academy.currency`, frozen onto every row; a request
never names it). One row carries at most 1,000,000.00. The API takes and
returns integers only; the web turns what is typed into piasters with string
arithmetic (`parseMoney`: Arabic-Indic digits and `٫` accepted, more than two
decimals refused — never silently rounded) and shows every amount with its
currency and two decimals. A percentage discount is integer basis points,
rounded half up to the piaster with integer math. No float ever reaches a
stored value.

## The balance — one definition

The `CenterChargeBalance` view, per charge:

- **net** = posted amount + Σ adjustments (0 once void)
- **paid** = Σ allocations of collections that are **not reversed**
- **outstanding** = net − paid

A learner's outstanding is the sum over their charges. Every screen, report,
the receipt's "still owed" and the statement read this view
(`CenterFeesService.balances`); the database's own checks read it too
(`center_charge_net/paid` select from it). There is no second formula.

Derived status (never stored): VOID · PAID (nothing outstanding) · OVERDUE
(due before the academy's local today) · PARTIALLY_PAID · DUE (due today) ·
UPCOMING. "Today" is the server's clock in the academy's timezone; a phone
with the wrong date changes nothing.

## What the database guarantees

- **Append-only history**: no DELETE on plans, charges, adjustments,
  collections or allocations; adjustments and allocations are never edited; a
  posted charge never changes (only voided, once); a collection and its
  receipt never change (only reversed, once).
- **At commit** (deferred constraint triggers): every collection is fully
  allocated — no money without a purpose, no credit balance; an allocation
  pays a charge of the same academy, learner and currency, not void, never
  beyond what it owes; an adjustment never takes a charge below 0 or below
  what was paid.
- **Tenant**: a charge/collection belongs to its learner's academy; a plan to
  its group's academy; a per-class charge to a class of that academy.
- **Idempotent posting**: unique (plan, learner, month) and (plan, learner,
  class); unique (academy, request key) for collections, one-time charges and
  adjustments; unique (academy, receipt number).
- Amounts bounded and positive; a revocation/void/reversal whole (when, who,
  why).

## Plans and charges

A plan belongs to **one group** — why a learner owes is always "in group G,
whose plan is P".

- **MONTHLY** — one charge per learner per **local** month, owed by whoever is
  in the group on the month's **anchor day** (the 1st, or the plan's start
  day in its first month), not withdrawn before it. **Full month, no
  proration.** Due on the plan's due day (1–28), or the anchor day if later.
  Only the current month is ever posted — never ahead, never back.
  - joins after the anchor day → nothing automatic; "**This month's fee**"
    (fees.manage) posts it on purpose, once;
  - leaves / transfers mid-month → keeps the month already posted in the old
    group; the new group charges from the next month;
  - withdrawn → no further months; existing debt stays.
- **PER_SESSION** — one charge per **C2 class actually attended** (PRESENT or
  LATE) in the plan's own group, from the plan's start. Not charged: absence,
  excused absence, cancelled classes, makeups (a guest in another group's
  class). A mark corrected afterwards does not void a posted charge — void it
  by hand. Due on the class's local date.
- **ONE_TIME** — a charge for one learner (book, exam, registration…) with a
  description, amount and due date (fees.manage).

**No back-charging.** A plan cannot start before the day it is created, and
nothing is posted by the migration or by turning C4 on. **Plan changes** only
affect what is posted afterwards: each charge keeps the amount it was posted
with. Posting happens when a plan is created, when the fee screens are read
(at most every 10 minutes per academy), on "post what is due now", and in
`CenterFeesWorker` every 30 minutes for academies with the flag on.

## Collecting

`POST /center-fees/students/:id/collections` with a request key, an integer
amount, a method (CASH · CARD_EXTERNAL — the center's own terminal, recorded
only · BANK_TRANSFER · OTHER) and optionally the allocation. In one
transaction, under the learner's register-row lock:

1. **replay** — the same request key returns the same receipt (a double
   click, a retry after a lost answer); the same key for something different
   is refused (`IDEMPOTENCY_KEY_REUSED`);
2. **allocate** — as named (each within what that charge owes, adding up to
   the amount exactly) or **oldest due first**; more than is owed is refused
   (`AMOUNT_EXCEEDS_BALANCE`) — C4 keeps no credit;
3. **receipt number** — `YYYY-000123`, per academy and local year, from an
   atomic counter (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), never
   count + 1; two desks get two numbers;
4. the collection (with the balance after it, printed on the receipt) and its
   allocations.

The screen shows the server's own allocation preview — learner, amount,
method, every charge it pays and what remains — before anything is taken,
and the confirm button cannot fire twice. Two receptionists taking the same
last 200 queue on the lock: one receipt, the other is told nothing (or less)
is owed.

**Receipt**: center, number, local date and time, learner and code, who took
it, method, each line it paid, total, what is still owed — no ids, no
phones. Printed from the browser (Arabic first, English LTR). A reversed
receipt keeps its number and prints with a REVERSED stamp.

## Corrections

- **Reverse** a collection recorded by mistake (fees.reverse): kept, marked
  reversed with reason, who and when; its allocations stop counting, the
  money is owed again; once.
- **Discount** (fees.adjust): an amount or a percentage of the posted
  amount, with a reason. **Correction**: signed (raise / lower), with a
  reason. Never below what was paid — reverse first.
- **Void** a charge posted by mistake (fees.manage): only with no money
  against it; it stays in the history and owes nothing.

Nothing is ever edited or deleted. The **statement** lists charges,
adjustments, collections, reversals and voids in time order with the running
balance, ending on the same outstanding as the summary.

## Permissions

| Capability | Owner | Reception & desk preset | Teacher |
|---|---|---|---|
| `fees.view` — a learner's fees, statement, receipts, who owes | ✓ | ✓ | — |
| `fees.collect` — take money, print the receipt | ✓ | ✓ | — |
| `fees.manage` — plans, one-time charges, this month's fee, void | ✓ | — | — |
| `fees.adjust` — discounts, corrections | ✓ | — | — |
| `fees.reverse` — reverse a collection | ✓ | — | — |
| `fees.report` — everyone's day, totals, CSV | ✓ | — (sees own day) | — |

All academy-wide (never granted course by course), grantable to assistants,
not teacher defaults: teaching a group shows no money. Students and guardians
see nothing of C4 in this phase.

## Desk and attendance

After the desk identifies a learner it shows a compact line — owed, overdue
— and **Collect** (C3's check-in is untouched). **Attendance never depends on
money**: an owing or overdue learner checks in by card, code, the class sheet
or Rush exactly as before; collecting is a separate, deliberate action.

## Screens

- **Desk** fee line + Collect.
- **Student 360 → Center fees**: owed / overdue / paid / next due, charges
  with status and their adjustments, receipts, Collect, one-time charge,
  this month's fee, discount/correct, void, statement.
- **/center/fees**: *Who owes* (search by name or code, filter owing /
  overdue / part paid / paid up, paged on the server, totals), *Collections*
  (a day's recorded collections by method, reversals apart — everyone's with
  fees.report, one's own otherwise; CSV), *Fee plans* (create, change the
  amount for the future, stop, post what is due now).

## Audit

`fees.plan.create|update|archive`, `fees.charge.create|monthly|void`,
`fees.discount`, `fees.adjust`, `fees.collect` (amount, method, receipt
number, allocations), `fees.reverse` — ids and amounts; no names, phones or
notes.

## Performance (local, 10,000 learners, 30,000 monthly charges)

Summary 2–3 ms, statement ~5 ms, a collection ~15 ms, who-owes page ~0.4 s,
the day ~20 ms. Posting a month for 10,000 learners in one group ~9 s (the
background worker; real groups are tens to hundreds).

## Known limitations

- No credit balance: overpayment is refused; change is given in cash.
- No automatic proration; a mid-month joiner's month is posted by hand.
- A per-class charge is not voided automatically if attendance is corrected.
- Monthly charges are posted for the current month only (no billing ahead).
- Refund of real cash is expressed as a reversal (the receipt stays, marked).
- No student / guardian portal for statements yet.

## C5 seam

The center now knows what it is owed and what it collected per learner. A
natural next phase is **teacher settlement** (what a center owes its
teachers from collected fees) — kept out of C4 on purpose.
