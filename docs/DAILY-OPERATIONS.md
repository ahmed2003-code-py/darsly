# Center Operations C7 — The Day's Operations & Daily Close

One page for a center's business day — classes, attendance, desk check-ins,
collections and reversals, follow-up, paper exams — what is still open, and a
recorded, versioned close. Shipped behind the `dailyOperations` feature flag
(default **off**, per academy, independent of the other Center Operations flags).

Code: `apps/api/src/daily-ops/` (`DailyOpsService`, `DailyOpsController`),
migration `20261106100000_daily_operations`, web `apps/web/src/pages/day/` and
`apps/web/src/lib/dailyOps.ts`. Tests: `daily-ops.integration.spec.ts` (real
Postgres, incl. a 10,000-learner scale run), `daily-ops.boundary.spec.ts`;
integrated journey, responsive audit and mutation run in
`scripts/e2e/{ops-journey-e2e,day-ux}.mjs` and `scripts/e2e/daily-mutate.cjs`.

## What C7 reads — and the one thing it writes

| Figure | Source | Rule |
|---|---|---|
| classes | C2 `GroupSession` | physical classes starting on the day (center-local), by status; ended / still to come by the database clock |
| attendance | C2 records of those classes | present / late / absent / excused / makeup visitors; **not marked** = expected roster (historical membership) minus own records, for ended classes |
| desk check-ins | C3 | records of the day's classes with method `QR` or `CODE` |
| collections | C4 `CenterCollection` | **received** on the day (by method, whatever happened later) and **reversals performed** on the day (whenever the money came in); net = received − reversed today |
| follow-up | C5 | cases opened / resolved / dismissed and families contacted on the day; open cases (state) |
| exams | C6 | exams published and grades corrected on the day; drafts with an exam date on or before it (state) |
| **day closes** | **C7** | owns `CenterDayClose` |

`daily-ops.boundary.spec.ts` fails the build if anything in `daily-ops/` writes
anything but a close, touches platform money, or if anything outside writes a
close. Closing never changes attendance, receipts or anything else — and an
open day blocks nobody (a learner checks in, pays, is graded as usual).

Facts are reproducible: they rest on timestamps that never change once set
(C4 freezes `receivedAt`; a reversal sets `reversedAt` once). `state` values
(open cases, drafts due) are as of the moment they are read.

## The business day

The academy's configured timezone defines the day (`localDayBounds`); "now" is
the database clock. A day in the future cannot be closed.

## Open items (exceptions)

- `CLASS_NOT_ENDED` — a non-cancelled class of the day has not ended yet.
- `ATTENDANCE_NOT_CLOSED` — an ended, non-cancelled class whose attendance was
  never closed (with how many expected learners are not marked).

Tasks shown but never blocking: exam drafts due, open follow-up cases.

## Closing

`POST /daily-ops/close { date, requestKey, exceptionNote?, reason? }` —
`daily.close`. Under an advisory lock on (academy, date) it recomputes the day
from the sources and appends version N+1:

- with open items, an **exception note** (3–500 chars) is required — the
  center closes knowingly, the items are recorded with the close;
- if the day was closed before, a **reason** (3–300 chars) is required — a
  re-close after a legitimate correction (a reversal, a late attendance close);
- the request key makes a retry or a double click one close; two different
  re-closes at once become consecutive versions, never a duplicate.

The database enforces it: closes are **append-only** (no UPDATE/DELETE),
versions are **consecutive**, a version > 1 carries a reason, exceptions carry
a note. The audit log records ids and counts — never the note or reason text.

**Reopening** is not a state: a day is "reopened" by closing it again with a
reason. Every version stays. `GET /daily-ops/day` shows the live figures, the
figures as closed (latest version), and which sections **drifted** since
(compared in canonical form — JSONB reorders keys).

## Who may see what

| | view the day | close | money | follow-up | exams |
|---|---|---|---|---|---|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| assistant with `daily.view` (+`daily.close`) | ✓ | as granted | with `fees.report` | with `followup.view` | — (group-scoped grades never see academy totals) |
| teacher, Reception preset | — | — | | | |

Both capabilities are academy-wide and offered on the Team screen only where
the flag is on; neither is a role default. The same redaction applies to the
figures stored in a close.

## Deferred (not in C7)

Teacher settlement (no compensation agreements in the model — a separate
financial project), cash-drawer counting and denominations, multi-day reports
and exports, scheduled/automatic closing.
