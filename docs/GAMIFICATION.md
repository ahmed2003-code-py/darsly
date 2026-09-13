# Darsly — Gamification & Engagement Engine

> How XP, coins, levels, achievements, missions and leaderboards work; what is
> wired to what; and which guarantees the rest of the codebase is allowed to
> rely on. Product-level feature list lives in [`FEATURES.md`](./FEATURES.md);
> platform architecture in [`SYSTEM.md`](./SYSTEM.md).

---

## 1. The shape of it

One engine sits behind every meaningful learning action:

```
lesson finished ─┐
quiz passed     ─┤
unit completed  ─┤
course certified├─→ GamificationService.record(event) ─→ ledger row
assignment sent ─┤                                      ├─→ XP + coins
live attended   ─┤                                      ├─→ level check
review written  ─┘                                      ├─→ mission progress
                                                        ├─→ achievement check
                                                        └─→ leaderboard bump
```

`record()` is the **only** way XP or coins come into existence. Learning flows
call it with a description of what the student did; everything downstream —
caps, idempotency, promotions, missions, boards — is enforced in that one place
rather than at each call site.

Two guarantees callers depend on:

| Guarantee | How |
|---|---|
| **Never throws** | `record()` catches internally and returns an empty outcome. A lesson must finish whether or not the points system is healthy. |
| **Never double-pays** | Every award is written behind `GamificationEvent.idempotencyKey`, a unique index. Retries, duplicated heartbeats and double-submits collapse to one. |

---

## 2. What already existed, and was *not* rebuilt

This was added to a working product. The rule was to extend, never to duplicate.

| Concept | Where it lives (unchanged) | What changed |
|---|---|---|
| **Streak** | `StudentProfile.currentStreak / longestStreak / lastActivityDate`, rolled by `ProgressService.touchActivity()` | Gained freezes + milestone rewards. Still the *only* streak counter in the product — the engine reads it, never keeps its own. |
| **Weekly goal** | `StudentProfile.weeklyGoalLessons` | Reused as-is, now surfaced in the gamification snapshot. |
| **Badges** | 6 definitions computed on the fly in `StudentExtrasService.badges()` | Became `Achievement` rows **under the same keys** (`first_enroll`, `streak_7`, `dedicated`, `quiz_ace`, `first_certificate`, `scholar`), so nothing a student earned disappeared. The old endpoint still works. |
| **Progress** | `LessonProgress.completedAt` | Untouched — it is read as the completion signal, never written by the engine. |
| **Notifications** | `NotificationsService.create()` | Reused as the comms layer, behind a priority + cooldown policy (§7). |
| **Money wallet** | `WalletTransaction` (piasters), `wallet/` module | Never touched. Coins are a different ledger in a different module (§5). |
| **Certificates** | `CertificatesService.checkCourseCompletion()` | Hooked, not replaced — it still owns issuance. |

---

## 3. Data model

12 additive tables. No existing table changed; the migration is
`20260912032358_gamification_engine` and is guarded (`IF NOT EXISTS`) so it is
safe to re-run.

| Table | Purpose |
|---|---|
| `GamificationEvent` | The append-only ledger. Every XP/coin movement, with its cause. Also the audit trail and the anti-abuse record. |
| `StudentGamification` | Per-student aggregate (xp, level, coins, counters, freezes, active title). Denormalised for cheap reads; the ledger is the truth. |
| `XpRule` | What each event pays + its caps. Admin-editable. |
| `LevelTier` | Level thresholds and names. Admin-editable. |
| `Achievement` / `StudentAchievement` | Definitions (metric + threshold) and what each student holds. |
| `Title` / `StudentTitle` | Display titles, and who has unlocked them. |
| `StudentMission` | One mission/quest for one student for one period. |
| `LeaderboardEntry` | Incrementally maintained board totals, per scope × period. |
| `Reward` / `RewardRedemption` | The coin store and its purchase history. |

Indexes that matter: `GamificationEvent(studentId, createdAt)`,
`(tenantId, createdAt)`, `(studentId, type)`; and the covering
`LeaderboardEntry(scope, scopeId, period, periodKey, xp DESC)` that makes a
board read an index range rather than a scan.

---

## 4. XP, and why it cannot be farmed

Values are seeded into `XpRule` and editable at
`/admin/gamification` — nothing is hard-coded in application logic.

| Event | XP | Coins | Daily cap | Times per entity |
|---|---|---|---|---|
| `LESSON_COMPLETED` | 25 | 10 | 300 | 1 |
| `QUIZ_COMPLETED` | 20 | 5 | 60 | unlimited |
| `QUIZ_PASSED` | 30 | 15 | — | 1 |
| `QUIZ_PERFECT` | 50 | 25 | — | 1 |
| `UNIT_COMPLETED` | 75 | 30 | — | 1 |
| `COURSE_COMPLETED` | 500 | 250 | — | 1 |
| `CERTIFICATE_EARNED` | 100 | 50 | — | 1 |
| `ASSIGNMENT_SUBMITTED` | 25 | 10 | — | 1 |
| `ASSIGNMENT_GRADED_HIGH` (≥85%) | 40 | 20 | — | 1 |
| `LIVE_ATTENDED` | 50 | 25 | — | 1 |
| `MISSION_COMPLETED` | 50 | 25 | — | 1 |
| `WEEKLY_QUEST_COMPLETED` | 250 | 100 | — | 1 |
| `STREAK_MILESTONE` | scaled | scaled | — | 1 |
| `REVIEW_SUBMITTED` | 15 | 10 | — | 1 |

**Four layers stop farming:**

1. **Idempotency key** — derived from the action (`LESSON_COMPLETED:<student>:<lesson>`),
   never from the request. Re-watching a finished lesson pays nothing, ever.
2. **`perEntityLimit`** — a second award for the same entity is refused even
   under a freshly-invented key.
3. **`dailyCap`** — XP is trimmed to what is left of the day's allowance. Past
   the cap the work *still counts* toward missions and progress; it just stops
   paying. The student did the quiz — they only stop farming it.
4. **Upstream reality checks** — completion at ≥90% is already capped by
   elapsed wall-clock time in `PlaybackService`, so a video left running or a
   forged `watchedPct` cannot complete a lesson.

Deliberately **not** rewarded: opening a page, pressing play, starting a lesson,
refreshing. There is no `LESSON_STARTED` payout, because paying for those
teaches students to generate events instead of to learn.

Reviews pay for **participation, not sentiment** — a one-star review earns
exactly what a five-star one does, keyed on the course so edits cannot be farmed.

---

## 5. Coins are not money

Darsly Coins live in `GamificationEvent.coinsAwarded` (signed) and
`StudentGamification.coins`. The real-money wallet is `WalletTransaction`, in
piasters, in the `wallet/` module. Nothing in the gamification module can read
or write it, there is no conversion path in either direction, and an integration
test asserts that earning coins leaves `WalletTransaction` untouched.

Coins buy: streak freezes, XP boosts, titles, cosmetics, and — only where an
admin configures one — a real-world prize, which is created `PENDING` and
requires a human to mark it delivered.

Spending is one conditional write (`WHERE coins >= cost`), so two taps on a slow
connection cannot buy the same thing twice on one balance.

### The cosmetics sink

The Student Studio is where most coins actually go. It is a **consumer of this
engine, not a second one**: the same balance, the same ledger table, the same
conditional debit, the same idempotency discipline. There is no second currency
and no second XP system.

One rule matters and is worth restating: **XP is never spent.** It is
progression. A cosmetic may be gated behind `requiredLevel`, but unlocking it
can never cost a student the level they earned. See [`STUDIO.md`](./STUDIO.md).

---

## 6. Periods, and the timezone

Every boundary — mission day, leaderboard week, "early bird" — is computed in
**Africa/Cairo**, not server time (`period.util.ts`). Weeks start **Saturday**;
the weekend is **Friday + Saturday**.

Egypt has kept summer time since 2023, so the offset is +2 in winter and +3 in
summer. The helpers resolve the real offset per instant. (An earlier draft
hard-coded `+02:00` and silently dropped the first hour of every day out of
daily caps and mission backfills for half the year; there are tests for both
offsets now.)

Missions are **generated on read**, not on a schedule — this codebase has no
cron, and a nightly job would write rows for every student in the database
whether they open the app or not.

---

## 7. Notifications: priority and cooldown

Engagement features are how products become annoying, so the policy is narrow:

| Event | Notifies? | Why |
|---|---|---|
| Achievement unlocked | **No** | Celebrated inline the moment it happens. Six lessons in a sitting would otherwise mean six alerts for things the student just watched appear. |
| Level up | Yes | Happens about ten times in a student's life. |
| Streak milestone | Yes | Seven of them exist, total. |

On top of that, **at most 2 gamification alerts per day**, counted from the
notifications themselves so the cap survives restarts and holds across
instances. A student who crosses three tiers in one sitting is congratulated
once.

---

## 8. Leaderboards & fairness

Boards are **written incrementally** inside the award transaction, never
aggregated from the ledger at read time.

- **Scopes**: `GLOBAL` (the explicit cross-tenant exception), `ACADEMY`,
  `COURSE`.
- **Periods**: `WEEKLY` (resets Saturday), `MONTHLY`, `ALLTIME`.
- **The student's own row is always returned**, wherever it sits, plus two
  neighbours either side and the exact XP gap to the position above.
- **Divisions** (Bronze → Master) are derived from *weekly* XP, so they reset
  with the week. A single all-time board is won permanently by whoever started
  first; this gives a student who has a good week a real promotion regardless of
  how long they have been here.

**Tenant isolation**: `ACADEMY` and `COURSE` boards are refused unless the
caller has an enrolment in that academy/course. Teachers see only their own
academy. Analytics are scoped the same way. Integration tests cover both.

---

## 9. Missions & quests

Generated from what the student *actually has* — a live-session mission is never
offered to a student whose teacher runs none, and a quiz mission never appears
in a course without quizzes. Selection is seeded per student per period, so
refreshing does not reroll. Progress made before the missions were generated is
backfilled (but not retro-paid).

Daily: 3 missions. Weekly: 2 quests.

---

## 10. API

**Student** (`/student/gamification`, role STUDENT)

```
GET  /                      snapshot: level, xp, coins, streak, rank, missions, achievements
GET  /achievements          every achievement with progress
GET  /missions              today + this week
GET  /leaderboard           ?scope=&scopeId=&period=  (entitlement-checked)
GET  /rewards               the coin store
POST /rewards/redeem        { rewardKey }
GET  /activity              XP/coin history
POST /title                 { titleKey | null }
```

**Teacher** (`/teacher/gamification`, capability `analytics.read`, tenant-scoped)

```
GET /analytics              engagement + retention for this academy
GET /leaderboard            this academy's board
```

**Admin** (`/admin/gamification`, role SUPER_ADMIN)

```
GET   /analytics                     platform-wide
GET   /config                        rules + levels + achievements + rewards
PATCH /xp-rules/:event               retune an event's payout and caps
PATCH /levels/:level                 move a threshold / rename a tier
PATCH /achievements/:key             retune or retire
PATCH /rewards/:key                  reprice / restock / withdraw
GET   /redemptions                   real-world prizes awaiting a human
POST  /redemptions/:id/fulfil        mark delivered
```

Config edits drop the in-process cache immediately, so a change is live on the
next award rather than a minute later.

---

## 11. Analytics: measured, not asserted

Everything in `GamificationAnalyticsService` is counted from events that
happened. There are no projections and no invented figures.

Retention is **cohort** retention measured from a student's *first recorded
activity*, not from signup — a student who registered in March and started
learning in September is a September learner. An academy young enough to have no
cohort yet returns "no data", which the interface renders as `—` rather than
`0%`: a brand-new academy has not achieved zero retention, it has not been
around long enough to have any.

---

## 12. Where it plugs into existing code

| File | Hook |
|---|---|
| `playback/playback.service.ts` | heartbeat ≥90% → `LESSON_COMPLETED`, study-window counters, unit check, streak milestone. Heartbeat response carries the outcome so the player celebrates in the same round trip. |
| `assessments/quizzes.service.ts` | submit + manual grade → `QUIZ_COMPLETED` / `QUIZ_PASSED` / `QUIZ_PERFECT`; `markLessonComplete` → `LESSON_COMPLETED`. Response carries the outcome. |
| `assessments/assignments.service.ts` | submit → `ASSIGNMENT_SUBMITTED` + `LESSON_COMPLETED`; grade ≥85% → `ASSIGNMENT_GRADED_HIGH`. |
| `assessments/certificates.service.ts` | on issue → `COURSE_COMPLETED` + `CERTIFICATE_EARNED`. |
| `live/live.service.ts` | `join()` inside the session window → `LIVE_ATTENDED`. |
| `reviews/reviews.service.ts` | on upsert → `REVIEW_SUBMITTED`. |
| `progress/progress.service.ts` | `touchActivity()` now returns the roll and spends a streak freeze when exactly one day was missed. |

---

## 13. Status

**Implemented and UI-visible**: XP, coins, levels, achievements (incl. all six
legacy badges), titles, daily missions, weekly quests, streak freezes and
milestones, leaderboards (global/academy/course × weekly/monthly/all-time) with
personal position and divisions, reward store, XP boosts, XP history, student
Learning Center, restructured dashboard, lesson/quiz celebration, profile
integration, teacher engagement analytics, admin control centre.

**Implemented, backend-only**: real-world reward fulfilment queue (admin UI
exists; no student-facing "claim" flow beyond redeeming).

**Deliberately not built** (and why): student-vs-student quiz battles,
challenge invitations, team/class competitions and seasonal events. These are a
substantial subsystem of their own — matchmaking, invitation state machines,
anti-collusion — and shipping a half-built battle mode would be worse than
shipping a coherent system without one. The `CHALLENGE_WON` event type and its
XP rule are seeded, so the engine is ready for them.

**Since superseded**: this section used to say dark mode was not applicable.
The platform now has a light/dark switch *and* a second theming axis on top of
per-academy branding — the student's own. Every gamification surface follows
both, because all of it reads theme tokens rather than literals.

One consequence worth knowing: anything **earned** — XP, coins, rank, level
progress, mission rewards, achievements — is drawn in the `student-gold`
semantic rather than in the accent. That is what gives "this was earned" one
colour across the whole app instead of an amber hard-coded into each component
that happened to need one.

---

## 14. Tests

`npx jest src/gamification` — 33 tests.

Unit (mocked): payouts, daily caps, per-entity limits, inactive rules,
level promotion, mission cascade, XP boost consumption, notification cooldown,
failure isolation, Cairo period boundaries in both DST offsets.

Integration (real Postgres, skips itself when unreachable): idempotency,
**concurrent** double-award, daily cap enforcement across many attempts, level
progression, achievement unlock-once, leaderboard ranking and personal position,
**tenant isolation** on boards and analytics, atomic coin spending under two
simultaneous redemptions, and the coins-never-touch-the-wallet guarantee.

Full suite: `npx jest` — 684 tests across 39 files.
