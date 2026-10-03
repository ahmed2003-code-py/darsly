# Center Operations (C1–C9) — Architecture Overview

Darsly's offline-center product: the register of a center's learners, its
classes and attendance, the reception desk, fees and receipts, follow-up with
families, paper exams, the day's operations and close, and what the center owes
its teachers. Each phase is its own module, its own migration, its own feature
flag (default **off**, enabled per academy by a platform admin in Super Admin →
Academies → Features) and its own doc.

| Phase | Flag | Module | Doc |
|---|---|---|---|
| C1 Student registry | `studentRegistry` | `center-students/` | [CENTER-STUDENT-REGISTRY.md](./CENTER-STUDENT-REGISTRY.md) |
| C2 Classes & attendance | `classOperations` | `academy-ops/`, `class-ops/` | [CENTER-CLASS-OPERATIONS.md](./CENTER-CLASS-OPERATIONS.md) |
| C3 QR cards & reception desk | `receptionDesk` | `desk/` | [CENTER-RECEPTION-DESK.md](./CENTER-RECEPTION-DESK.md) |
| C4 Fees & collections | `centerFees` | `center-fees/` | [CENTER-FEES.md](./CENTER-FEES.md) |
| C5 Follow-up & guardians | `studentFollowUp` | `follow-up/`, `guardian/` | [STUDENT-FOLLOW-UP.md](./STUDENT-FOLLOW-UP.md) |
| C6 Paper exams & grades | `paperExams` | `paper-exams/` | [PAPER-EXAMS.md](./PAPER-EXAMS.md) |
| C7 Daily operations & close | `dailyOperations` | `daily-ops/` | [DAILY-OPERATIONS.md](./DAILY-OPERATIONS.md) |
| C8 Teacher settlement | `teacherSettlement` | `teacher-settlement/` | [TEACHER-SETTLEMENT.md](./TEACHER-SETTLEMENT.md) |
| C9 Hardening | — | (see below) | this file |

## The three money boundaries

| Domain | Direction | Tables | Writer |
|---|---|---|---|
| Platform money | learner → platform → teacher (online courses, Live) | `Payment`, `Ledger*`, `Wallet`, `PayoutRequest`, `LivePurchase`, `CommercialTerms` | platform payment / payout services |
| Center fees (C4) | learner → center (cash at the desk) | `Center*` | `center-fees/` only |
| Teacher settlement (C8) | center → teacher | `TeacherAgreement`, `TeacherSettlement*` | `teacher-settlement/` only |

No center module reads or writes platform money; no platform code reads center
money. Each `*.boundary.spec.ts` fails the build if a module writes a table it
does not own. Readers across a boundary go through the owner's service (C7 and
C8 read C4 through `CenterFeesService`). Money is integer piastres everywhere;
financial history is append-only and corrected by new records (reversals,
adjustments, voids), never by edits — enforced by database triggers.

## Shared foundations

- **Learner identity** — `AcademyStudent` (C1) is the center's learner; a
  Darsly account is optional and linked. Every center table is tenant-keyed by
  `academyId`, and triggers refuse cross-tenant references.
- **Time** — the academy's timezone defines the business day; "now" is the
  database clock.
- **Capabilities** — every route is `@AcademyStaffFeature(capability, flag)`:
  the flag off → 403 for everyone, then the capability. Assistants get only
  what the owner grants (ceilings in `academy/permissions.ts`).
- **Idempotency** — every money or state-changing POST takes a `requestKey`;
  a retry returns the original result.
- **Integrity** — `scripts/check-center-operations-integrity.mjs` (read-only,
  `default_transaction_read_only`) checks cross-phase invariants on any
  database, production included.

## C9 — hardening decisions

- **Super Admin feature switch** — the switch is no longer optimistic: it shows
  the persisted value, is locked while saving, says "Saved: ON/OFF · time" or
  "Not saved — …", warns before leaving mid-save, and the API returns each
  flag's `savedAt`.
- **Integrity checker** — rules aligned with the real model (assistants,
  makeup records, learners without enrollments, deleted academies) and extended
  to C1–C8.
- **Teacher of a started class** — only the owner can change it
  (`SESSION_TEACHER_LOCKED`), because it decides teacher pay.
- **Exports** — C8 settlement statement (CSV). Earlier phases already export.
- **Deferred (P2)**: a cash drawer / shift count, multi-day financial reports,
  a teacher-facing Student 360. Teachers work through class rosters and exam
  sheets today.
- **Guardian of a withdrawn learner** — policy: the guardian keeps read access
  to the learner's history. Documented, no change.
