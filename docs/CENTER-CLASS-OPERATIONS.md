# Center Operations C2 — Timetable, Classes & Attendance

The physical-class loop: a group's **weekly timetable** generates **real
classes**; each class has its own **attendance sheet** — check-in, lateness by
the server clock, closing (the unmarked become absent), corrections, and
**makeup** attendance from another group. Shipped behind the
`classOperations` feature flag (default **off**, enabled per academy by a
platform admin). C3 (QR / reception desk) consumes this foundation.

Code: `apps/api/src/class-ops/` (`ClassScheduleService`,
`ClassAttendanceService`, `ClassOpsWorker`, `zoned-time.ts`), group changes in
`apps/api/src/academy-ops/groups.service.ts`, migration
`20261101100000_class_operations`, web `apps/web/src/pages/classes/` and
`apps/web/src/lib/classOps.ts`.

## Model

| Thing | Meaning |
|---|---|
| `Group` (+ `subjectId`, `gradeId`, `capacity`, `lateGraceMin`) | A class's configuration. All optional; a group never needs a Course. `capacity` = the most **open** memberships (null = unlimited). |
| `GroupMembership` | One row per **stint**: `[addedAt, deletedAt)`. Leaving ends the stint; coming back opens a new row. At most one open stint per (group, student) — partial unique index — and no two stints overlap — GiST exclusion. |
| `GroupScheduleSlot` | A weekly rule: weekday (0 = Sunday), local start minute, duration, room, teacher, place, `validFrom`/`validTo` (local dates). Soft-deleted. |
| `GroupSession` (+ `slotId`, `occurrenceDate`, `customizedAt`, `startedAt`) | **The class.** The one calendar: generated classes and one-off sessions are the same rows, under the existing room/teacher/group GiST constraints. |
| `AttendanceSession` (+ `groupSessionId`, `closedAt`) | A class's sheet (unique by `groupSessionId`). It still carries `groupId` and the class's **local date**, so every reader by group/date (Needs Attention, guardians, Student 360, analytics) keeps working. Date-based sheets from before C2 (`groupSessionId` null) stay unique per (group, date). |
| `AttendanceRecord` (+ `method` MANUAL/AUTO, `checkedInAt`, `homeGroupId`, `makeupForSessionId`) | One student at one class. `AUTO` only ever means "absent because the sheet was closed" (CHECK). |
| `Academy.timezone` (default `Africa/Cairo`), `Academy.lateGraceMin` (default 10) | The clock a timetable is written in, and the late rule (a group may override the grace). |

Tenant consistency (slot ↔ group ↔ room academy, sheet ↔ class, record ↔
sheet/home group/missed class) is enforced by triggers as well as by the API.

## Timetable → classes

- **Time zones.** "Saturday 18:00" is 18:00 in the academy's zone. Each class
  is converted on its own date (`zonedToInstant`), so summer time moves the UTC
  instant, never the local time. A time inside a spring-forward gap moves
  forward by the gap; a repeated time at fall-back takes its first occurrence.
- **Horizon.** Classes exist 28 local days ahead. Created when a slot is saved,
  topped up by `ClassOpsWorker` (every 30 min, flagged academies) and when
  Today is read. Idempotent; every generation for a slot runs under a per-slot
  advisory lock.
- **Identity.** `(slotId, occurrenceDate)` is unique among undeleted rows. A
  **cancelled class keeps its key**: generating again never brings it back.
- **Conflicts.** Room, teacher (across academies) and group overlaps are the
  existing GiST constraints; a teacher's live stream is checked too. A save is
  refused with the first conflicting local date. The background top-up skips a
  conflicting class (logged) instead of failing.
- **Editing a slot.** From today (or the new `validFrom`), every **untouched**
  future class — SCHEDULED, not started, not edited by hand, no sheet — is
  moved in place if its date still fits, removed if it no longer does, and
  missing dates are created. Cancelled, started, hand-edited and attended
  classes, and everything in the past, are never touched. The web asks the
  server for a **dry run** first and shows the result in words before saving.
- **Removing a slot** drops its untouched future classes; the rest stays.
- **Cancelling one class** is `PATCH /teacher/sessions/:id {status:CANCELLED}` —
  refused once attendance is taken or the sheet is closed.
- A departing teacher is cleared from slots as well as future classes.

## Attendance

- **Who is expected**: students whose stint overlaps the class window
  (`addedAt < endAt` and `deletedAt` null or `> startAt`), excluding a register
  record withdrawn before the class began. Old classes show who was in the
  group *then*.
- **One lock.** Start, mark, close, makeup and cancel all take `FOR UPDATE` on
  the class's `GroupSession` row, so they serialise.
- **Clock.** Every time is the database's `now()`. A **first check-in**
  (PRESENT with no record, or only an AUTO absence) made **while the class is
  on** and after `startAt + grace` is stored as `LATE`. Marks made after the
  class ended are records written afterwards and are stored as given. Every
  later change is a person's decision, stored as made. Client-sent times are
  refused (the DTO whitelist).
- **Opening.** Marking opens an hour before the class; closing needs the class
  to have started.
- **Close.** Every expected student without a record becomes ABSENT (AUTO);
  `closedAt` is set once (a second close is a no-op); the class becomes
  COMPLETED. Records stay correctable after closing (an AUTO absence changed by
  a person becomes MANUAL); every change is audited.
- **Makeup.** A register student (ACTIVE, same academy) of another group
  attends this class: the record lives on the class they sat in, with
  `homeGroupId` (and the missed class, when given). Their membership and their
  home class's record are not touched. Makeups count against the class's seats.
  Found by student **code** (anyone taking the attendance) or by name (only with
  `student.directory`).

## Capacity & membership

- Seats are taken under a row lock on the group (`writeMemberships`): the last
  seat goes to exactly one desk; the other gets `GROUP_FULL`. Applies to the
  group screen, the C1 desk and imports (an import row whose group is full is
  still registered, without the group — reason `GROUP_FULL`).
- Capacity cannot be set below the students already seated.
- **Transfer** (`POST /teacher/groups/:id/members/:studentId/transfer`) ends one
  stint and opens another in one transaction (register row, then both groups,
  locked in a fixed order).

## Permissions

| Action | Capability | Scope |
|---|---|---|
| Today, a class, start, mark, close, makeup | `attendance.mark` | OWNER: every group; others: assigned groups |
| Timetable, options | `schedule.manage` | same |
| Seats, subject, year, grace, transfer | `group.manage` | same |

Reception (the C1 preset) holds none of these. Everything needs the
`classOperations` flag; foreign ids are 404.

## Known limitations

- No academy closures / holidays (cancel individual classes).
- Slots are weekly and PHYSICAL; hybrid classes keep physical and live
  attendance separate.
- The group's timezone is the academy's; there is no UI to change
  `Academy.timezone` yet.
- The 2 pre-C2 production sheets stay date-based (no deterministic class).
