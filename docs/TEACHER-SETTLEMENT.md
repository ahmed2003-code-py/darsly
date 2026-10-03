# Center Operations C8 — Teacher Settlement

What a center owes each of its teachers for a period, how it was calculated,
what has been paid, and why every number is what it is. Shipped behind the
`teacherSettlement` feature flag (default **off**, per academy, independent of
the other Center Operations flags).

Code: `apps/api/src/teacher-settlement/` (`TeacherSettlementService`,
`TeacherSettlementController`), migration `20261107100000_teacher_settlement`,
web `apps/web/src/pages/settlements/` and `apps/web/src/lib/settlements.ts`.
Tests: `settlement.integration.spec.ts` (real Postgres, incl. a scale run),
`settlement.boundary.spec.ts`; browser journey and responsive audit in
`scripts/e2e/{settlements-e2e,settlements-ux}.mjs`.

## The three money boundaries

Darsly has three kinds of money. They never share a table, a service or a
calculation.

| Domain | What it is | Owns |
|---|---|---|
| **Platform money** | students paying for online courses / Live, wallets, payouts, revenue share | `Payment`, `Ledger*`, `Wallet`, `PayoutRequest`, `LivePurchase`, `CommercialTerms` |
| **Center fees (C4)** | what a learner owes the center and the cash the desk receives | `CenterFeePlan`, `CenterCharge`, `CenterCollection`, `CenterAllocation`, … |
| **Teacher settlement (C8)** | what the center owes its teachers | `TeacherAgreement`, `TeacherSettlement*` |

C8 **reads** C4 only through `CenterFeesService.allocationsForGroups` (the C4
boundary forbids anyone else from touching `Center*` tables) and C2 classes
through the schedule service. It writes only its own tables.
`settlement.boundary.spec.ts` fails the build if `teacher-settlement/` writes
anything else or touches platform money, or if anything outside it writes a
settlement table. Paying a teacher here records that the center paid them
(cash, transfer, other); it never moves money on the platform.

## Who taught a class

`GroupSession.teacherUserId` is the per-class teacher snapshot — a later change
to the group's teacher does not rewrite history. Because teachers hold
`schedule.manage` by default, **only the owner** (or a platform admin) can
change the teacher of a class that has already started
(`SESSION_TEACHER_LOCKED`). A change after finalization shows as drift (below).

## Agreements (rates)

Effective-dated, append-only. One agreement = teacher + method + amount + from
(+ optional end) + group scope. An agreement can be **ended once**; it is never
edited or deleted (database trigger). A new rate is a new agreement.

| Method | Amount | Scope |
|---|---|---|
| `PER_SESSION` | piastres per class | groups, empty = all of the teacher's classes |
| `PERCENT_OF_COLLECTIONS` | basis points (1–10,000) | explicit groups required (`AGREEMENT_SCOPE_REQUIRED`) |
| `FIXED_PERIOD` | piastres per calendar month | no groups (`AGREEMENT_SCOPE_INVALID`) |

- Two agreements of the same method for the same teacher cannot overlap in both
  dates and groups (empty = all) — `AGREEMENT_OVERLAP`, enforced in a trigger
  under an advisory lock.
- A new agreement, or an end, cannot reach into a period that already has a
  settlement (`AGREEMENT_IN_SETTLED_PERIOD`) — settled money is never
  re-priced silently.

## The calculation (one function: `compute`)

Days are the academy's local days; "now" is the database clock.

- **PER_SESSION** — one line per class that is PHYSICAL or HYBRID, not
  cancelled, ended, with attendance closed (an empty class still counts), whose
  teacher snapshot is the teacher, whose group is in scope and whose local date
  is in both the period and the agreement. Ended classes with attendance still
  open are listed as **pending**, not paid.
- **PERCENT_OF_COLLECTIONS** — one line per C4 allocation on a non-reversed
  collection received in the period, on a MONTHLY / PER_SESSION plan charge of
  a group in scope. One-time charges are excluded. Each allocation earns
  `round_half_up(amount × bps / 10000)`, rounded per allocation.
- **FIXED_PERIOD** — per calendar month covered by both the period and the
  agreement: full month = the amount exactly, partial = amount × covered days /
  days in month, half-up.

All money is integer piastres.

## Settlements

`POST /teacher-settlement/settlements { teacherUserId, from, to,
expectedGrossCents, requestKey }` — `settlement.finalize`. A period is at most
92 days and cannot end in the future. Under an advisory lock it recomputes; if
the gross differs from the preview the user saw → `SETTLEMENT_PREVIEW_CHANGED`;
nothing to pay → `SETTLEMENT_EMPTY`. The lines are **frozen** with the
settlement. A retry with the same key returns the same settlement (one audit
entry). The database refuses two non-void settlements of the same teacher with
overlapping periods (exclusion constraint) and the same source (class /
allocation / month) settled twice (`TeacherSettlementLine_once`).

- **Drift** — the detail page recomputes and compares to the frozen lines
  (added / removed / changed, Δ). The frozen numbers never change; a correction
  is an adjustment.
- **Adjustments** — `BONUS` (> 0), `DEDUCTION` (< 0), `CORRECTION` (≠ 0), with
  a reason (3–300). Payable = gross + adjustments can never go below what was
  paid (`SETTLEMENT_ADJUST_BELOW_PAID`) or below zero.
- **Payments** — `settlement.pay`; amount, method, optional reference (≤ 60).
  Never more than what is still owed (`SETTLEMENT_OVERPAYMENT`, checked under
  a row lock, and by a CHECK constraint). Status: FINALIZED → PARTIALLY_PAID →
  PAID.
- **Void** — only while nothing was paid (`SETTLEMENT_HAS_PAYMENTS`), with a
  reason; frees the period and sources to be settled again. Final.
- Adjustments and payments are append-only, request-keyed (a retry is one
  record).
- **Statement** — CSV per settlement (UTF-8 BOM, integer money, spreadsheet
  formula guard). Typed text starting with `= + - @` (a reason, a payment
  reference) is prefixed with `'`; the statement's own amounts, including the
  negative payment and deduction rows, stay plain numbers a spreadsheet can
  add.

## Capabilities

`settlement.view`, `settlement.manage` (agreements), `settlement.finalize`,
`settlement.pay` — academy-wide, grantable to assistants, **not** given to any
role by default (the owner has all). Teachers see nothing here unless granted.
Audit metadata carries ids and amounts, never reasons or references.

## Integrity

`scripts/check-center-operations-integrity.mjs` checks (read-only): no
overlapping agreements, settlement totals = lines / adjustments / payments,
paid ≤ payable, no source settled twice, line tenant = settlement tenant.
