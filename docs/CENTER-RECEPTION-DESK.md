# Center Operations C3 — QR Student Cards & the Reception Desk

The front door of a center: a learner walks in, the desk **identifies** them
(their QR card, their C1 student code, or a register search), sees **today's
real classes** of theirs (C2 occurrences), and **checks them in** — PRESENT or
LATE by the server's clock — then the next learner. Shipped behind the
`receptionDesk` feature flag (default **off**, enabled per academy by a
platform admin, independent of `classOperations`).

C3 is a thin layer: **identify → resolve → find the real C2 class → check in
through C2**. It adds no attendance logic of its own and no money of any kind.

Code: `apps/api/src/desk/` (`DeskService`, `DeskController`, `card-token.ts`),
`ClassAttendanceService.deskCheckIn` in `apps/api/src/class-ops/`, migration
`20261102100000_reception_desk`, web `apps/web/src/pages/desk/` (`DeskPage`,
`QrScanner`, `CardPanel`, `cardPrint.ts`) and `apps/web/src/lib/desk.ts`.
Tests: `desk.integration.spec.ts` (real Postgres), `card-token.spec.ts`,
`apps/web/src/lib/desk.spec.ts`; browser E2E, responsive audit and mutation
run in `scripts/e2e/desk-*.{cjs,mjs}`.

## Model

| Thing | Meaning |
|---|---|
| `AcademyStudentCard` | One printed card of one register learner (`AcademyStudent`) at one academy. `tokenHash` (SHA-256, hex), `issuedAt/By`, `revokedAt/By`, `revokeReason`. Never deleted, never reactivated — history. |
| `CardRevokeReason` | `LOST`, `DAMAGED`, `SECURITY`, `REISSUED`, `MANUAL`, `OTHER`. |
| `AttendanceMethod` + `QR`, `CODE` | How a desk check-in identified the learner. Derived by the server from the identifier it verified; `MANUAL` = picked from the register search (and every class-screen mark). |

What PostgreSQL itself guarantees:

- **one active card per learner** — partial unique index on `academyStudentId WHERE revokedAt IS NULL`;
- **only a digest is stored** — CHECK `tokenHash ~ '^[0-9a-f]{64}$'` (a 48-digit raw token cannot be written);
- **a revocation is whole** — `revokedAt`, `revokedBy`, `revokeReason` all set or none;
- **tenant and identity** — trigger: a card's academy is its learner's academy; `tokenHash`, academy, learner and issue fields never change; a revoked card never un-revokes.

## Token design and threat model

- **Token**: 48 random decimal digits from the CSPRNG (`crypto.randomInt`), ≈ **159 bits**.
  Decimal on purpose: a USB scanner "types" through the desk computer's
  keyboard layout — an Arabic layout mangles letters but leaves digits — and
  QR numeric mode keeps the code small (version 2–3).
- **The QR holds the token and nothing else**: no name, phone, code, id,
  academy, attendance, money or auth.
- **Stored as SHA-256 only.** The raw token exists in the issue/reissue
  response and in the print preview while it is open. It is never logged,
  audited or persisted; **printing again = reissuing** (the old card stops
  working in the same transaction).
- **Never authentication.** A token identifies a card to **signed-in staff
  of the card's academy who hold `desk.checkin`** — nothing else: no login,
  no password reset, no account claim, no profile change, no money, no public
  lookup. There is no public route that takes a token.
- **No URL tokens.** Tokens travel only in POST bodies (`/desk/resolve`,
  `/desk/check-in`), so they cannot reach access logs, history, Referer or
  analytics. The web never puts a scan in a URL: the desk classifies input
  first (48 digits = card), and the C1 register search refuses to query
  anything that looks like a card number.
- **Unknown = foreign = revoked-looking-alike?** A card of another academy is
  answered exactly like a random number (`CARD_NOT_FOUND`); nothing says
  where it is from. A revoked card of *this* academy answers `CARD_REVOKED`
  (and does not reveal whose it was).
- **Probing.** Guessing a 159-bit token is hopeless; still, failed card/code
  lookups are counted per user and academy (Redis, 10-minute window; per
  process without Redis) and after **30 misses** lookups pause
  (`DESK_TOO_MANY_MISSES`, 429). Successful scans never count, so a fast queue
  never meets it. The global per-user limit (120/min) still applies.
- **Hashed before any query.** The token is hashed in the API before the
  database sees it, so no SQL, query log or database error can contain it.
  The error filter logs route templates, never paths or bodies.

## Card lifecycle

| Action | Rule |
|---|---|
| **Issue** | Only when the learner has no active card and is ACTIVE. Locks the learner's register row; a second issue (double tap, another desk) gets `CARD_ALREADY_ACTIVE`. Returns the token once, with the printable fields. |
| **Reissue** | The screen names the card it replaces (`cardId`); under the learner's lock the old card is revoked (reason, default `REISSUED`) and the new one created in one transaction. A stale screen or a second desk gets `CARD_CHANGED` instead of silently killing the card the first one just printed. |
| **Revoke** | Idempotent (revoking a revoked card is a no-op). The UPDATE's row lock waits for any check-in holding that card (`FOR SHARE`), so a card revoked a moment ago cannot still check someone in. |
| **Print** | Browser printing through a hidden frame (no popup, no URL): ID-1 size (85.6 × 54 mm), two per A4 row. Center name/logo, learner name, code, year, QR. No phones, no ids, no money. |

Audit: `card.issue`, `card.reissue`, `card.revoke` — ids and reasons only.

## The desk

**One loop**: identify → classes today → check in → ready for the next.

- **Desktop / tablet**: one box that keeps focus. A USB/Bluetooth scanner
  (keyboard wedge: digits then Enter) resolves the card; if focus wandered,
  the first digit brings it back. **Enter on an empty box checks in the one
  class on screen** — a queue needs no mouse. The box also takes a six-digit
  code (Arabic-Indic and Persian digits read as 0-9) or a name/phone, which
  goes to the C1 register search (for those who hold `student.directory`).
- **Phone**: a big **Scan QR card** button opens the camera; results appear
  in the same place, one-handed; the keyboard never pops up on its own.
- **Camera**: loaded only when opened. The browser's `BarcodeDetector`
  (Android Chrome, recent Safari) or `jsQR` (loaded on demand) decodes each
  frame in the tab; frames are never uploaded, stored or sent anywhere.
  Denied / no camera / busy / unsupported each have their own words and a
  "type the code instead" way out.
- **Rush mode** (a switch, remembered on the device): a scan checks in on
  the spot **only when the server says there is exactly one class of theirs
  open now**; anything else (two classes, makeup, withdrawn, closed, full,
  unknown card) stops and asks. Success shows big (icon + words + colour,
  never colour alone), then the desk is ready again after ~2 s; a list of the
  recent check-ins stays beside it. Optional tones (success / already /
  refused), mutable.
- **Offline / timeout**: "No connection — nothing was recorded", with Retry.
  A retry that finds the check-in already made answers "already checked in"
  — never two records.
- **New learner**: the C1 registration dialog opens from the desk and hands
  the new learner back to it; a card can be issued there.
- **Student 360** shows the card state (active / none / cancelled) with
  issue, reissue (= print again) and revoke for `card.manage`.

## Resolving the class

`POST /desk/resolve` answers with the learner (name, code, year, photo if
they have one, groups, whether they hold a card), **today's classes of
theirs** and **other classes open now** (for a makeup), each with its state
and — for makeups — seats, and one `action`:

| action | when |
|---|---|
| `CHECK_IN` | exactly one class of theirs is open and not yet marked |
| `ALREADY` | exactly one is open and they already have a record there |
| `CHOOSE` | more than one class of theirs is open — the desk picks |
| `NO_CLASS` | none open now (with the next one today, if any), or classes are off |
| `WITHDRAWN` | the learner is withdrawn: identified, never checked in |

"Theirs" = C2's expected rule (a membership stint overlapping the class, not
withdrawn before it began). Classes are C2 `GroupSession` rows of the
academy's local **today** (never a weekly slot). **Check-in window**: from
**60 minutes before the start** (the same moment C2 opens the sheet) until
**the class ends**. After the end, marks are made on the class screen.

## Checking in — through C2

`POST /desk/check-in` re-identifies the learner from the same identifier
(so the method is the server's) and calls `ClassAttendanceService.deskCheckIn`:

- the class row is locked `FOR UPDATE` (the same lock as start/mark/close/
  makeup/cancel), the time is the **database's `now()`**;
- refused: cancelled, not open yet, **ended** (`CLASS_ENDED`), **closed**
  (`ATTENDANCE_CLOSED` — the desk never reopens a sheet), withdrawn, a card
  revoked meanwhile;
- a record that already exists is **reported, never changed** (the desk has
  no correction power; corrections stay with `attendance.mark` on the class
  screen);
- an expected learner: **PRESENT**, or **LATE** once `startAt + grace` has
  passed (group grace, else the academy's) — exactly C2's first-check-in rule;
- anyone else: only as a **makeup the desk confirmed** (`makeup: true`),
  through C2's shared seating (`seatGuest`): home group derived or named,
  capacity = expected + makeups already in, no membership created, the home
  class untouched;
- one record per learner per class (unique), so two desks, a QR and a code
  at once, a double scan or a retry all end in one record;
- audit: the same `attendance.mark` / `attendance.makeup` actions as the
  class screen, with `desk: true` and the method — ids and statuses only.

## Permissions

| Capability | Who | Reaches |
|---|---|---|
| `desk.checkin` | owner; granted to assistants (Reception & desk preset) | identify any learner of the academy, see their classes today, check in (no corrections) |
| `card.manage` | owner; granted to assistants | issue, reissue, revoke cards |

Both are academy-wide (never granted course by course), inside the assistant
ceiling, and **not** teacher defaults — a teacher keeps C2 attendance for
their own groups. The **Reception & desk** preset = `student.view`,
`student.directory`, `student.register`, `desk.checkin`, `card.manage`: no
money, wallet, payouts, commercial terms, settings, courses, teaching, Live
moderation or analytics. Every route: ACTIVE membership + capability +
`receptionDesk` flag (403 otherwise), and the flag guard is independent of
`classOperations` (with classes off the desk identifies but says so).

## Performance (10,000 learners, 10,000 cards, 200 classes today, local)

Token lookup 0.03 ms (unique index scan); resolve by card ≈ 60–70 ms, by
code ≈ 60–70 ms, automatic check-in ≈ 140–165 ms (medians, in-process,
several queries each). Browser Rush queue: 12 learners in 10 s including
scanner typing. No search engine, no extra service: PostgreSQL indexes.

## Known limitations

- **No reprint**: the server cannot reproduce a card (by design); printing
  again reissues it and the old card stops working.
- **Bulk printing** of many cards at once is not built (one card per
  issue); the print sheet already lays out two per A4 row.
- No offline queue: offline shows "no connection" and nothing is recorded
  until the retry succeeds.
- Photo: shown only when the learner's account has one (register-only
  learners have none). No face recognition, no biometrics.
- Camera scanning cannot be exercised by real hardware in CI; it is tested
  with Chrome's fake camera showing a real QR and with a refused camera.

## C4 (finance) integration point

The desk result is where a future fee state would appear — **nothing of the
kind exists in C3**: no charges, collections, receipts, debts or payment
buttons, and attendance is never gated on money. C4 would add its own read
model to the resolve payload behind its own capability and flag.
