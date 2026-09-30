# Center Operations C1 — Student Registry

What a center's desk uses to register, find and enrol students who may never
have opened Darsly. Shipped behind the `studentRegistry` feature flag (default
**off**, enabled per academy by a platform admin).

Code: `apps/api/src/center-students/`, migration
`20261031100000_center_student_registry`, web `apps/web/src/pages/center/`
(`CenterStudentsPage`, `StudentImportPage`, `StudentForm`, `RegistryCard`) and
`apps/web/src/lib/centerStudents.ts` / `studentSheet.ts`.

## Model

| Thing | Meaning |
|---|---|
| `StudentProfile` | The learner. Still the only learner identity: every learner table (`GroupMembership`, `AttendanceRecord`, `GuardianLink`, `Enrollment`, …) keeps pointing at it. |
| `AcademyStudent` | **The academy's record of a learner** — its code, the contacts it keeps, school, year, `ACTIVE`/`WITHDRAWN`, source. Unique `(academyId, studentId)`, `(academyId, code)`, `(academyId, requestKey)`. Two academies teaching one learner hold two records over one profile. |
| Shell student | A `STUDENT` user with **no email, phone, username or password**, created by a desk registration or an import, marked `StudentProfile.provisionedByAcademyId`. Nothing can sign in as it (see *Authentication*). The marker is provenance, never authority. |
| `StudentImport` | One validated spreadsheet batch. Its stored rows (names, phones) are cleared on commit; an uncommitted preview is purged after 24 h. |

Phones on `AcademyStudent` are contact details — never unique, never login
handles, never compared with `User.phone`. Siblings share a guardian number; a
child often gives a parent's.

### Database-enforced rules (the migration)

- `nameNormalized` is written by a trigger from `fullName` using
  `academy_student_name_key()` — **the only Arabic normaliser** (strips harakat,
  tatweel and invisible marks; أ/إ/آ/ٱ→ا, ى/ی→ي, ة→ه, ؤ→و, ئ→ي, ک→ك;
  Arabic/Persian digits→0-9; «عبد الله»=«عبدالله»; collapses spaces). The API
  never writes the column; search normalises its input with the same function.
- `code`: CHECK `academy_student_code_ok()` — six digits, first never 0, last a
  Luhn check digit (catches every single mistyped digit).
- Phones: CHECK `^\+201[0125][0-9]{8}$` (what `normalizeEgyptianPhone` writes).
- `WITHDRAWN` ⇔ `leftAt` is set (CHECK).
- `pg_trgm` GIN index on `nameNormalized` for substring name search.
- **Every new `Enrollment` registers its student** (`AFTER INSERT/UPDATE` trigger,
  source `ONLINE`). It can never fail an enrollment: errors become a `WARNING`,
  and `GroupsService.admissible` re-ensures the row if one was ever missed.

### Backfill

The migration registers every live (academy, learner) pair that already
existed — an enrollment in the academy's course, a membership in its group, or
an active guardian link it issued — skipping soft-deleted academies, profiles,
users and source rows. Idempotent (re-running changes nothing). Production at
migration time: see the C1 deployment report.

## Behaviour

- **Registration** (`POST /center-students`): user + profile + record (+ first
  group) in one transaction. `requestKey` (client-generated per action) makes it
  retry-safe: a repeat, double click, concurrent copy or retry after a lost
  response returns the first learner (`created: false`).
- **Duplicates**: same normalised name **and** a shared phone → `409
  STUDENT_POSSIBLE_DUPLICATE` with candidates; `confirmDuplicate: true`
  registers anyway and writes `student.duplicate.override`. Registrations of
  one name in one academy are serialised by an advisory lock, so two desks
  cannot both pass the check. Nothing is ever merged.
- **Search** (`GET /center-students?q=`): a valid code → exact code; an
  Egyptian mobile → exact student/guardian phone; other digits → code prefix or
  phone fragment; anything else → every word must appear in the name key.
  Always scoped to the academy — a total never counts another academy's rows.
- **Groups**: `POST /center-students/:id/groups` (add only, idempotent).
  `GroupsService.addMembers` now admits any `ACTIVE` register learner — no fake
  enrollment — and refuses `WITHDRAWN` ones (`STUDENT_WITHDRAWN`).
- **Withdraw / reactivate**: row-locked, converging transitions. Withdrawing
  ends the learner's group places in this academy (chat rooms left); it never
  touches enrollments, guardian links, chats, attendance or money.
  Reactivating does not restore group places.
- **Import**: the browser parses `.xlsx`/`.csv` (read-excel-file; values only —
  no formulas, no macros) and sends cell text. `preview` applies the desk
  rules server-side and stores the rows it would write; `commit` names the
  batch only. Commit takes a lease, writes 100-row chunks with per-row
  `requestKey = import:<id>:<row>`, and resumes after a crash; repeats return
  the outcome. Max 5,000 rows per file.
- **Export**: UTF-8 CSV with BOM; phones as `010 1234 5678`; formula-leading
  cells neutralised; no internal ids.

## Authorization

Capabilities (both academy-wide, neither a TEACHER default):

- `student.directory` — search, view, export the register; Student 360 of
  register-only learners.
- `student.register` — register, edit, withdraw/reactivate, import, add to a
  group.

OWNER holds both. The Team screen's **Reception** preset grants
`student.view`, `student.directory`, `student.register` with all courses in
scope (a course-limited assistant can never hold the register). Every route is
`@AcademyStaffFeature(capability, 'studentRegistry')`; `GET
/center-students/access` alone is flag-agnostic (for the menu). Cross-academy
ids are 404.

## Authentication (why a shell cannot sign in)

Login resolves the identifier to one unique non-null column (email / phone /
username) and refuses a user without a password hash; a shell has none of the
four. Forgot/reset password is keyed by email; activation tokens are issued
only by the admin Center flow; change-password and refresh need a live
session; OTP serves device enrollment only; guardian and guest tokens are
bound to their own users. The student code is a desk lookup key and is never
accepted anywhere as a credential. Account claiming/activation is **not** part
of C1.

## Platform metrics

An *online student account* is a `STUDENT` user with a password. The admin
overview count, the admin signup trend and platform-wide streak averages count
only those; shells are counted where they are real — each academy's register.

## Not in C1

QR/cards, attendance changes, schedules, fees/receipts/cash, paper exams,
notifications, notes, follow-ups, branches, account claiming, guardian
accounts from the register, legacy center codes.
