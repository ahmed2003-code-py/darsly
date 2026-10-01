# Center Operations C5 — Student Follow-up & Guardian Connection

Who needs a call today, the cases being worked, and the contact history with
each family — plus the bridge from the phone typed at registration to a real
guardian. Shipped behind the `studentFollowUp` feature flag (default **off**,
per academy, independent of `studentRegistry` / `classOperations` /
`receptionDesk` / `centerFees`).

Code: `apps/api/src/follow-up/` (`FollowUpSignalsService`, `FollowUpService`,
`TimelineService`, `FollowUpSettingsService`, `GuardianFeesView`,
`FollowUpController`), migration `20261104100000_student_follow_up`, web
`apps/web/src/pages/followup/` and `apps/web/src/lib/followUp.ts`. Tests:
`follow-up.integration.spec.ts` (real Postgres), `follow-up.boundary.spec.ts`,
`apps/web/src/lib/followUp.spec.ts`; browser E2E, responsive audit and mutation
run in `scripts/e2e/followup-*.{mjs,cjs}`.

## What C5 owns — and what it only reads

| Fact | Owner | C5 |
|---|---|---|
| identity, register, group stints | C1 | reads |
| classes, attendance, makeups | C2 | reads |
| cards, desk check-in | C3 | reads |
| charges, collections, receipts, balance | C4 | reads **only through `CenterFeesService`** |
| guardians and their access | Guardian domain | reads; the invite is the existing flow |
| **follow-up cases, contact history** | **C5** | owns |

`follow-up.boundary.spec.ts` fails the build if anything in `follow-up/`
writes a model another phase owns, reads a C4 model directly, or touches
platform money — and if anything outside `follow-up/` writes a case or a
contact. C5 never changes attendance, money or a guardian's access.

## Signals — derived, never stored

`GET /follow-up/signals` computes on every read, for the academy's local today:

| Signal | From | Rule |
|---|---|---|
| `ABSENT_TODAY` | C2 | an ABSENT record in the learner's own group for a class dated today |
| `ABSENT_STREAK` | C2 | the newest N records in a group are all unexcused absences (N = `absenceStreak`, default 3) |
| `LATE_STREAK` | C2 | the newest N records in a group are all LATE (`lateStreak`, default 3) |
| `FEES_OVERDUE` | C4 | money still owed on a charge due more than `overdueDays` (default 7) days ago — via `CenterFeesService.overdueLearners`, the same balance view as everything else; only where `centerFees` is on |

Attendance rules, matching C2:

- **EXCUSED** is neither an absence nor a break: it is skipped.
- An absence a **makeup** covered (a PRESENT/LATE makeup record for that class) is not an absence: it breaks the streak.
- A **guest's** record in another group belongs to that visit, never to that group's streaks.
- **Cancelled** classes and **withdrawn** learners raise nothing.

A signal is a row on a list. It never changes attendance or money, never
contacts anyone, never blocks check-in, payment or anything else. Each row
says whether a case is open for it and whether the family was already
contacted today. Amounts appear only for a caller holding `fees.view`.

Set-based: one window query reads the academy's last 120 days of attendance
for both streaks (the run's start comes from one ordered array, not a
join-back), one query for today's absences, one C4 call for fees, then cases
and contacts in bulk. Measured locally: 10,000 learners, 160,000 attendance
records → about 0.6 s for the whole list (it was 1.2 s before the plan was
measured and the query reshaped).

## Cases

`StudentFollowUp`: a learner, a reason (`ABSENT_TODAY` · `ABSENT_STREAK` ·
`LATE_STREAK` · `FEES_OVERDUE` · `MANUAL`), the signal occurrence it is about
(`signalKey` — the class, the class a streak started on, the oldest overdue
charge; none for a manual case), an optional note, assignee and due date.

- **Opening** checks the signal is really raised now, takes the learner's
  register-row lock, and is idempotent: the same request key replays; the
  same derived signal has at most one OPEN case (partial unique index). Five
  desks opening it at once make one case.
- **Closing** — RESOLVED or DISMISSED, with a reason — is a compare-and-set on
  OPEN: of two people closing at once exactly one succeeds; the other is told
  it is already closed. A closed case is history (a trigger refuses any later
  change). Once closed, the same signal may be opened again if it persists.

## Contacts — append-only

`StudentContact`: who (`GUARDIAN_LINK` — an active guardian of this learner
here — `REGISTER_GUARDIAN`, `STUDENT`, `OTHER`), how (call, WhatsApp, in person,
in-app, other), what came of it, an optional note (≤ 500 characters), when (the
server's clock) and who. Never edited, never deleted (triggers). Idempotent by
request key: a double click, a retry after a lost answer or after the network
came back records it once.

**Nothing is sent by C5.** The call opens `tel:` and WhatsApp opens `wa.me` on
the staff member's own phone. The WhatsApp text is fixed and privacy-safe — no
name, amount, attendance detail, grade or note:

> مرحبًا، نرجو التواصل مع السنتر بخصوص متابعة الطالب.
> Hello, please contact the center regarding the student's follow-up.

## Register contact ≠ guardian account ≠ connected guardian

- The **register contact** (`AcademyStudent.guardianName/guardianPhone`, typed
  at the desk) is only a number. Reading it creates nothing, signs no one in,
  proves nothing.
- A **guardian account** exists only after a staff member explicitly presses
  *Invite as guardian* (Student 360 → Guardians), which opens the existing
  guardian form pre-filled — still edited and confirmed by staff — and goes
  through the existing `GuardianService.add`.
- The guardian is **INVITED** until one of their access links is actually
  opened, then **CONNECTED** (derived from the existing token use count — no
  new verification mechanism), **REVOKED** when removed.

No backfill: existing register contacts stay contacts until someone invites.

## Guardians and fees (owner's choice, off by default)

`AcademyFollowUpSettings.guardianFeesVisible` (owner only; independent of
whether the center uses C4 internally). When on, and follow-up is on, a
connected guardian's portal shows that child's outstanding and overdue amounts
and receipts (number, date, amount, method, reversed) —
`CenterFeesService.guardianView` returns only those fields: never notes,
reasons, adjustments, who collected, totals or another learner.

## Student 360

A **Follow-up** tab: who can be reached (guardians with their state, the
register contact marked "number only", the learner's own phone) with call /
WhatsApp, open cases (assign, close, log a contact), contact history, closed
cases, and the **timeline**.

The timeline is a **read model** composed on every request from the domains
that own each fact — registration, withdrawal/return (C1's audit trail), group
stints and transfers, attendance (with makeups), cards, guardians linked or
removed, cases and contacts, and fee events. **Fee events are fetched only for
a caller holding `fees.view` where `centerFees` is on**; otherwise they are
never requested from C4 at all (not hidden in the browser). No event table.

## Settings

Owner only (`academy.manage`): `absenceStreak` 2–10, `lateStreak` 2–10,
`overdueDays` 0–90, `guardianFeesVisible`. Bounds enforced in the DTO and a
database CHECK. Changing a threshold changes what is derived from then on —
never attendance, money, contacts or existing cases.

## Permissions

| Capability | Owner | Reception & desk preset | Teacher |
|---|---|---|---|
| `followup.view` — signals, cases, contacts and notes, timeline | ✓ | ✓ | — |
| `followup.manage` — open/assign/close cases, log contacts | ✓ | ✓ | — |
| `guardian.manage` — invite / resend / remove guardians | ✓ | ✓ | ✓ (their students) |
| settings | ✓ | — | — |

Both `followup.*` are academy-wide, grantable to assistants, never a teacher
default. Students and guardians never see follow-up; notes never reach a
guardian, the desk, a card, the audit log or the application logs.

## Audit

`followup.case.open|assign|resolve|dismiss`, `followup.contact.log`,
`followup.settings.update` — ids, reasons, channels, outcomes; never a note, a
name or a phone.

## Known limitations

- No automated messages (SMS, WhatsApp API, push, email) — by design for C5.
- Guardians receive no notification of a follow-up; the conversation happens
  on the staff member's phone.
- Signals look back 120 days; a run is exact up to 30 records per group.
- A streak counts records, not calendar weeks.
