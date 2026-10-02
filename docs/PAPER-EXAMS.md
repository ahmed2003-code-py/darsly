# Center Operations C6 — Paper Exams & Grades

Paper exams a center gives in class, per group: the marks, their publication,
corrections with a reason, makeups, statistics, and the low grades that follow
up should know about. Shipped behind the `paperExams` feature flag (default
**off**, per academy, independent of every other Center Operations flag).

Code: `apps/api/src/paper-exams/` (`GradesReadService` — the read side every
other module uses — `PaperExamsService`, `PaperExamsController`), migration
`20261105100000_paper_exams`, web `apps/web/src/pages/exams/` and
`apps/web/src/lib/paperExams.ts`. Tests: `paper-exams.integration.spec.ts`
(real Postgres), `paper-exams.boundary.spec.ts`,
`apps/web/src/lib/paperExams.spec.ts`; browser E2E, responsive audit and
mutation run in `scripts/e2e/exams-*.{mjs,cjs}`.

## What C6 owns — and what it never touches

| Fact | Owner | C6 |
|---|---|---|
| register, group stints, withdrawal | C1 | reads (the historical roster) |
| classes | C2 | reads (an exam may name its class) |
| teacher ↔ group assignments | C2 | reads (who reaches which exam) |
| follow-up cases | C5 | none — C5 derives `LOW_GRADE` from `GradesReadService` |
| **paper exams, results, revisions, grade settings** | **C6** | owns |
| online quizzes, assignments, challenges, OCR imports, gamification | online learning | **never read or written** |

`paper-exams.boundary.spec.ts` fails the build if anything in `paper-exams/`
writes a model another phase owns, touches an online assessment, OCR, AI,
fees or platform money — or if anything outside writes an exam, a result, a
revision or the grade settings, or if the online modules read a paper grade.
No AI ever grades anything.

## Marks

Integer **hundredths**: 30 → `3000`, 26.5 → `2650`, at most two decimals,
never a float. The web parses text with string arithmetic (Arabic digits and
the Arabic decimal sign included) and refuses rather than rounds. A full mark
is 0.01 – 1000.00; a pass mark is optional and ≤ the full mark.

Per learner a result is exactly one of:

| | meaning | statistics | low grade |
|---|---|---|---|
| `SCORED` (0 included) | sat the exam; the mark | counts | can be |
| `ABSENT` | did not sit | never | never |
| `EXCUSED` | did not sit, with an excuse | never | never |
| no row | not entered yet | — | — (a draft cannot publish so) |

Percent is basis points, round half up, integer only:
`floor((score·20000 + max) / (2·max))`.

## The roster — the group on the exam date

The learners expected on a sheet are those in the group **on the exam date**
(or during the named class), from membership history: joined before the end
of that day, not moved out before its start, not withdrawn before its start.
A later transfer, withdrawal or join never changes an old exam. A learner not
on it can be added on purpose as a **guest** (never a withdrawn one).

## Lifecycle

```
DRAFT ──publish──▶ PUBLISHED ──void──▶ VOID (final)
  └──────────────void──────────────────▶
```

- **Draft**: marks are entered in bulk — one request key per save (a retry or
  a double click is one save) and a version per row (a stale editor is told
  the current value; nothing is overwritten silently). Every change is a
  revision (`ENTRY` / `CLEAR`). An empty draft can be deleted; one that ever
  had marks is voided instead.
- **Publish** is atomic: under a lock on the exam, the roster is rebuilt;
  every expected learner needs an explicit result (`ROSTER_INCOMPLETE` names
  who is missing) and no row may belong to someone off it (`ROSTER_MISMATCH`).
- **Published**: the group, date, marks and class are frozen (the database
  enforces it). A grade changes only by a **correction**: version-checked,
  with a reason (3–300 chars) kept in the revision — never in the audit log,
  never shown to learners or guardians.
- **Void**: kept, with its reason, and excluded from everything. An original
  whose makeup is still live cannot be voided.

## Makeups

A makeup is its own exam (`kind = MAKEUP`, `makeupOfExamId` → a published
regular exam of the same group) with the original's marks. Its sheet offers
the learners ABSENT or EXCUSED in the original who do not already hold a
makeup result; several learners share one sitting, and not every candidate
needs a result to publish it. **One effective makeup per learner and
original** — a partial unique index on `makeupKey`; voiding a makeup frees it.
The original absence is never rewritten. The **effective result** of a
learner on an exam is their SCORED result in a published makeup, else their
original result.

## Statistics — one implementation

`GradesReadService.stats` — one SQL aggregate over **SCORED results only**:
entered, scored, absent, excused, average, median, highest, lowest, and the
pass count / rate where the exam has a pass mark. The web shows what it is
given and computes nothing. No GPA, no ranking, no percentile, no trend graph.
A makeup's statistics are its own; the original's never include it.

## LOW_GRADE in follow-up (C5)

Derived on every read, never stored, never opens a case by itself: a
learner's effective result on a **published, non-void** regular exam from the
last 60 days is SCORED and below the exam's pass mark — or, without one,
below the academy's `lowGradePercent` (default 50%, exact integer
comparison). A correction or a published makeup changes it by itself.
Only for a caller holding `grades.view`, and only in the groups they reach;
Reception sees no grade signal and cannot open a case on one. A low grade,
overdue fees and an open case together never block check-in.

## Who may do what

| | view | enter, publish, makeup | correct, void | settings |
|---|---|---|---|---|
| owner | all groups | ✓ | ✓ | ✓ |
| teacher (default `grades.view` + `grades.manage`) | **currently assigned** groups | ✓ | — | — |
| assistant | as granted, assigned groups | as granted | as granted | — |
| Reception preset | — | — | — | — |

A foreign group is a 403 (`GROUP_NOT_ASSIGNED`), another academy's exam a
404. When an assignment ends, so does access to that group's exams. The
Team screen offers the `grades` capabilities only where paper exams are on.
A teacher's Student 360 itself stays course-scoped as before; the grades tab
inside it shows only the groups the viewer reaches.

## Guardians

`guardianGradesVisible` (default **off**). When on: the child's published,
non-void results — title, date, mark / full mark, percent, pass/fail where
there is a pass mark, and whether it was a makeup. Never drafts, notes,
correction reasons, revisions, who entered it, other learners or ranks.

## Export

`GET /paper-exams/:id/export` — CSV (UTF-8 BOM) of the sheet: code, name,
status, score, max, percent, passed. Any cell starting with `= + - @ TAB CR`
is prefixed with `'`, so a spreadsheet never runs it. No import.

## The database keeps the rules

CHECKs (shape, bounds, MAKEUP ⇔ original, published/void columns whole),
the partial unique index for one effective makeup, and triggers: revisions
append-only; tenant on every link; legal status transitions only, VOID final;
a published exam's group, date and marks frozen; only an empty draft deleted;
a result's score ≤ the full mark; a published result never deleted.

## API

| | route | capability |
|---|---|---|
| access probes | `GET /paper-exams/access`, `GET /paper-exams/my-access` | membership |
| groups I reach | `GET /paper-exams/groups` | `grades.view` |
| list | `GET /paper-exams?groupId&status&page` | `grades.view` |
| create | `POST /paper-exams` | `grades.manage` |
| sheet + stats | `GET /paper-exams/:id` | `grades.view` |
| edit / delete draft | `PATCH` / `DELETE /paper-exams/:id` | `grades.manage` |
| save draft marks | `PUT /paper-exams/:id/results` | `grades.manage` |
| publish | `POST /paper-exams/:id/publish` | `grades.manage` |
| makeup | `POST /paper-exams/:id/makeups` | `grades.manage` |
| correct | `POST /paper-exams/:id/results/:academyStudentId/correct` | `grades.correct` |
| void | `POST /paper-exams/:id/void` | `grades.correct` |
| CSV | `GET /paper-exams/:id/export` | `grades.view` |
| a learner's grades | `GET /paper-exams/by-student/:studentId` | `grades.view` |
| settings | `GET` / `PATCH /paper-exams/settings` | `grades.view` / `academy.manage` |

Every route but the access probes needs the `paperExams` flag; unknown body
fields are refused (400) by the global pipe — `academyId`, `status`,
`publishedAt`, `version`, `kind`, `enteredBy`, `makeupKey`, … are the server's.
