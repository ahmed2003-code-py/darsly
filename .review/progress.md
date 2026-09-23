# Remediation progress

Source of truth: `ARCHITECTURE_REVIEW.md` §11 (issue table) + §12 (roadmap).
Review was written at `ca4e6d9`; remediation starts from `62caf66` (one commit later),
so line numbers in the report are re-verified per fix rather than trusted.

## Step 0 — Baseline (2026-09-22)

- Backup: `/home/ahmedeldeeb/darsly-backups/darsly-local-20260922-163230.sql` (1.5 MB, 84 tables, verified complete).
- `REDISMS_DISABLE_POSTINSTALL=1 npm install` → restored `ioredis`, `@socket.io/redis-adapter`,
  `redis-memory-server`. **`package-lock.json` unchanged** (no version drift).
- `npx prisma migrate deploy` (localhost:5434) → 18 migrations applied, `Database schema is up to date!`,
  no drift, no P3009. `prisma generate` re-run.
- **BASELINE: 103/103 suites, 1539/1539 tests, 11/11 snapshots passed (~25 s).**
  (Was 101/103 and 1521/1531; +8 because `redis-throttler-storage.service.spec.ts` now compiles
  and its 8 tests count, and the 10 gamification integration tests now execute instead of erroring.)
- Note: the gamification integration suite now runs against the real local Postgres. It self-skips
  when no DB is reachable, which is what CI will hit.

| Issue | Branch | Status | Tests |
|---|---|---|---|
| — | `main` @ 62caf66 | baseline recorded | 1539/1539 |

### #4 detail
- `apps/api/src/common/filters/prisma-exception.filter.ts` + spec; registered via `APP_FILTER`
  in `app.module.ts:145`, matching the existing `APP_GUARD` convention.
- Mapping: P2002→409 ALREADY_EXISTS · P2003→409 RELATED_RECORD_CONFLICT · P2025→404 NOT_FOUND ·
  P2034→503 WRITE_CONFLICT. Unmapped codes stay 500 and are logged with code+meta.
- `@Catch(Prisma.PrismaClientKnownRequestError)` makes preservation structural: an HttpException
  cannot reach the filter, so ~525 existing throws are provably unaffected (asserted in the spec
  by reading the `__filterCatchExceptions__` metadata).
- The 14 call-site handlers catch first and are untouched; several treat P2002 as idempotency
  success (`gamification.service.ts:150`, `achievements.service.ts:56`) and still do.
- Body is exactly `{message, code}`. Prisma's message/meta never leave the server (asserted).
- No i18n strings added: `errorMessage.ts:96-98` uses `defaultValue:''` so an unknown code
  falls through to the per-status Arabic sentence.
- Fail-before proof: filter file moved aside → suite fails `TS2307 Cannot find module`, 0 tests.
  Restored → 9/9 pass.
- Verification: tsc api OK, tsc web OK, build OK, suite 104/104 & 1548/1548 (baseline 103/103, 1539/1539).

### #3 detail — verification, not a fix
- Probe: read-only `GET /api/v1/health` on `darslyapi-production.up.railway.app`, 11 requests.
  No auth/payment/reset endpoint touched; no limit exhausted; no 429 produced.
- Observed `X-RateLimit-Limit: 120` throughout, `X-RateLimit-Remaining`:
  - no header:        119, 118, 117
  - fixed spoof:      116, 115, 114
  - 4 distinct spoofs:113, 112, 111, 110
  - multi-hop chain:  109
  One unbroken sequence → **a single bucket**. A spoofed `X-Forwarded-For` never
  created a fresh count, so **Railway's edge replaces the inbound header**.
- Redis was live (counter monotonic and persistent), so this is NOT the fail-open
  inconclusive case.
- Corrected a factual error in the review: `@nestjs/throttler`'s default tracker returns
  `req.ip`, not `req.ips[0]` (`throttler.guard.js:141-143`).
- `apps/api/src/common/trust-proxy.spec.ts` already proves the leftmost-XFF mechanism; it was
  written for the real production bug (non-monotonic remaining 15,19,17,16,19 before
  `trust proxy` was set). Left untouched — the adversarial case it omits is not reachable.
- **No code changed. Fix 3 closed as not-a-defect.**

### #2 detail — durable video packaging
- New `VideoJob` table (migration `20260925100000_video_jobs`, additive: 1 table + 2 enums).
  Partial unique index `VideoJob_active_per_asset_key ON (videoAssetId) WHERE status IN
  ('QUEUED','RUNNING')` — written in raw SQL because Prisma has no syntax for partial unique
  indexes; verified present in Postgres via pg_indexes.
- Claim = `FOR UPDATE SKIP LOCKED`, lease 5 min + heartbeat at half-lease, backoff 30/60/120s
  capped at 10 min, MAX_ATTEMPTS 3, RETRYABLE/TERMINAL.
- `main.ts` now calls `app.enableShutdownHooks()` — without it no `onModuleDestroy` fires on
  Railway's SIGTERM, so every drain (incl. AiJobWorker's existing one) was dead code. Prereq for #6.
- Both call sites are transactional: asset row + job row commit together.
- API contract unchanged; asset set to PROCESSING at enqueue so `/uploads/videos/:id/status`
  reads exactly as before.
- Own config: `VIDEO_WORKER_ENABLED=true`, `VIDEO_WORKER_CONCURRENCY=1` (NOT the AI worker's 3 —
  ffmpeg saturates a core on the container serving HTTP). Documented in `.env.example`.
- Fail-before proof: queue implementation moved aside → 4 suites fail `TS2307`, 0 tests. Restored → all pass.
- Verification: tsc api OK, tsc web OK, prisma validate OK, migrate status "up to date",
  build OK, 107/107 suites & 1581/1581 tests (baseline 104/104, 1548/1548).

### #5 detail — Tier 1 only (DB-side aggregation)
- **Correction of record:** the review's "174 of 211 findMany unbounded" counted *syntax*, not
  risk. Re-parsed with brace matching: 168 unbounded, but most are bounded by their WHERE.
  Verified-safe examples that were wrongly implied risky: `wallet.service.ts:53` (sibling query
  has `take:50`; the unbounded one is PENDING topups for one student), `wallet.controller.ts:141`
  (`paymentId IN (…)` from a `take:10` query), `playback.service.ts:292` (one student, open
  sessions, recent window). **Real risk set ≈ 9 sites, not 174.**
- Converted (all `findMany` → `count`/`aggregate`/`groupBy`):
  `analytics.service.ts` teacherOverview (4 scans) and academyOverview (2);
  `admin-analytics.service.ts:135` (platform-wide, widest read in the codebase);
  `gamification-analytics.service.ts` ×3 (busiest table); `admin-centers.service.ts:215`.
- **Key constraint discovered:** `count`/`aggregate`/`groupBy` are in `READ_ACTIONS`
  (`prisma.service.ts:72-79`) so they inherit the soft-delete filter; `$queryRaw` does NOT.
  Using raw SQL here would have silently started counting deleted rows. Asserted in the spec.
- Semantics preserved: all-time totals stay all-time; only the two 6-month charts read rows,
  now windowed. `netCents ?? amountCents` split into two aggregates and re-added.
- `teacherOverview` had **no test at all** before this; now has a contract spec pinning keys,
  types, and that totals carry no date filter.
- Verification: tsc api/web OK, prisma validate OK, build OK, 105/105 suites & 1551/1551
  (branch baseline main = 103/103, 1539/1539). No migration, no index change, no API change.

## Found while fixing

- **#12 soft-delete/`findUnique` is RE-SCOPED, not fixed — the review was wrong twice.**
  Count: **202** `findUnique`/`findUniqueOrThrow` calls on soft-delete models, not 49.
  More importantly the implication was wrong: many of them *must* see soft-deleted rows.
  `enrollments.service.ts:176` looks up the compound unique `studentId_courseId` precisely so a
  previously-deleted enrolment is resurrected rather than hitting P2002 — the same pattern as
  `coupons.controller.ts`. Converting it to `findFirst` would introduce the bug the exemption
  exists to prevent, and `findFirst` cannot use a compound-unique key shorthand at all.
  Other sampled sites (`enrollments.service.ts:443,476,501`) re-read a row by id immediately
  after writing it, where deleted-state is irrelevant. **A blanket conversion is actively
  harmful.** The real options are a `$extends` migration with an explicit `withDeleted()` escape
  hatch (a major architecture change) or keeping it as a documented convention — a decision,
  not an implementation detail. Deferred under approval condition 6.

- **#35 alt-text half was a FALSE FINDING in the review.** Proper multi-line JSX parsing shows
  **all 42 `<img>` tags carry `alt`** (meaningful where informative, `alt=""` where decorative).
  The subagent used a line-based grep that missed attributes on following lines. Withdrawn.
  The other half of #35 — 25 native `confirm()` calls — is real but deferred: native confirm is
  browser-accessible, the impact is aesthetic/RTL, and converting 25 destructive-action call
  sites with no frontend test harness is a poor risk trade.

- **FOLLOW-UP / OPEN — Tier 2 pagination (breaking API change).** Four user-facing endpoints
  return bare arrays with no limit and would need a paginated envelope:
  `teachers/teachers.service.ts:91` (public teacher directory — **no `orderBy` at all**, so page
  boundaries would be non-deterministic; genuinely unbounded growth),
  `courses/courses.service.ts:383` (`listMine`), `student/student-extras.service.ts:36` (saved
  courses), `enrollments/enrollments.service.ts:323` (`myEnrollments`). All four are consumed by
  the SPA via direct `.map()`, so changing the shape needs coordinated frontend work.
  Prerequisite for any of them: give the directory a deterministic `orderBy`.
- **`QuizAttempt` is indexed only `([quizId, studentId])`** while analytics filters it through
  `quiz.lesson.unit.course.tenantId` — a deep relation walk with no supporting index. Converted
  to `count` so it no longer materialises rows, but the index gap remains.

- **PHASE 2 / OPEN — YouTube import is still fire-and-forget.** `courses.service.ts:909,932`
  call `void this.downloadAndProcessYoutube(...)`. This is a **worse** leak than the one fixed
  in #2: the yt-dlp download runs for minutes and strands the asset in **UPLOADING**, before
  PROCESSING is ever set — so even a "stuck in PROCESSING" sweep cannot find it. The VideoJob
  table was designed to take a second `VideoJobType` (`YOUTUBE_IMPORT`) for exactly this.
  Deliberately out of scope for #2 per instruction.

- **Migration `20260924100000_center_theme_grants` is timestamped in the future** (today is 2026-09-22).
  Any migration authored before the 24th sorts *before* it, so a later-authored migration can be
  applied earlier than one that already ran — an ordering/drift hazard. Not renamed (it is already
  applied in environments); noted only. Reported by the user at Step 0.

## Fixes

| Issue | Branch | Status | Tests |
|---|---|---|---|
| #1 CI + #20 linter | `fix/1-ci-and-linter` @ `0e1b1a6` | **pushed** | 1539/1539 (= baseline); lint 608 warn / 0 err |
| #4 Prisma exception filter | `fix/4-prisma-exception-filter` @ `ebb2acb` | **pushed** | 1548/1548 (+9, +1 suite) |
| #3 rate-limit tracker | — | **WITHDRAWN — disproved in production, no code change** | n/a |
| #2 video durable queue | `fix/2-video-durable-queue` @ `ba4dd8c` | **pushed** | 1581/1581 (+33, +3 suites) |
| #5 Tier 1 DB aggregation | `fix/5-tier1-db-aggregation` @ `740195f` | **pushed** | 1551/1551 (+12, +2 suites) |
| #6 AI worker drain | `fix/6-ai-worker-drain` @ `d49be3a` | **pushed** (branched from fix/2) | 1586/1586 (+5) |
| #7 dependency CVEs | `fix/7-dependency-cves` @ `80aec35` | **pushed** (non-breaking half) | 1539/1539 |
| #15 missing FK indexes | `fix/15-missing-fk-indexes` @ `c7c7e39` | **pushed** | 1539/1539 |
| #28 wallet top-up TOCTOU | `fix/28-wallet-topup-toctou` @ `a3d489b` | **pushed** | 1544/1544 (+5) |
| #27 public JWT hardening | `fix/27-public-jwt-hardening` @ `37967d7` | **pushed** | 1547/1547 (+8) |
| #31 integration skip-guard | `fix/31-integration-skip-guard` @ `2936daa` | **pushed** | 1545/1545 (+6) |
| #30 health dependencies | `fix/30-health-dependencies` @ `e3d35e0` | **pushed** | 1548/1548 (+9) |
| #14 locale code-split | `fix/14-locale-code-split` @ `d9e8e78` | **pushed** | 1539/1539; initial JS 333→99.9 KB |
| #16 Modal a11y | `fix/16-modal-a11y` @ `4ddbb0c` | **pushed** | 1539/1539 |
| #33 query error surface | `fix/33-query-error-surface` @ `055149c` | **pushed** | 1539/1539 |
| #26 upload magic bytes | `fix/26-upload-magic-bytes` @ `556cde6` | **pushed** | 1558/1558 (+19) |
| #8 e2e authz matrix | `fix/8-e2e-authz-matrix` @ `593a698` | **pushed** | 1539/1539 + **24/24 e2e** |
| #19 request id + logging | `fix/19-request-id-logging` @ `9560407` | **pushed** | 1556/1556 (+17) |
| #25 Docker hardening | `fix/25-docker-hardening` @ `9bd829b` | **pushed** | image built & run-verified |
| #35 alt text (half) | — | **WITHDRAWN — false finding** | n/a |
| #24 untested modules | `fix/24-untested-modules` @ `4546739` | **pushed** | 1562/1562 (+23) |
| #17 coupons service | `fix/17-coupons-service` @ `789c50e` | **pushed** | 1553/1553 (+14) |
| #12 soft-delete findUnique | — | **RE-SCOPED — deferred (cond. 6)** | n/a |
| #21 typed auth config | `fix/21-typed-config` @ `1ee193b` | **pushed** | 1557/1557 (+18) |

### #1/#20 detail
- `.github/workflows/ci.yml`: install → prisma generate → prisma validate → tsc (api, web)
  → lint → format:check → test → build → audit. Lint/format/audit are `continue-on-error`.
  Jest pinned to `--maxWorkers=2` (default cores-1 OOM-killed locally, exit 137).
- `eslint.config.mjs`: `allWarn()` helper rewrites every preset rule from `error` to `warn`,
  so the whole recommended + typeChecked rule set is visible without blocking.
- Deps added (dev, root): eslint, @eslint/js, typescript-eslint, prettier, eslint-config-prettier
  — **plus eslint-plugin-react-hooks, which was beyond the approved five** (see summary).
- Every CI step dry-run locally before commit: prisma validate OK, tsc api OK, tsc web OK,
  build OK, test 1539/1539, prettier --check reports 498 files (reported, not fixed).
- Falsifiable proof the linter works: temporary `__lint-probe__.ts` with a floating promise
  → `eslint --max-warnings 0` exit 1; probe deleted → exit 0. Probe not committed.

### Lint baseline (608 warnings, 0 errors)
254 no-explicit-any · 114 no-unnecessary-type-assertion · 112 no-floating-promises ·
33 no-unsafe-enum-comparison · 31 no-unused-vars · 19 no-require-imports · 10 unnamed ·
6 no-useless-assignment · 6 no-implied-eval (all in specs, benign) · 5 no-base-to-string ·
5 react-hooks/exhaustive-deps · 4 no-useless-escape · 4 await-thenable · rest singletons.
By area: apps/web 352, apps/api 256.

### #4 detail
- `apps/api/src/common/filters/prisma-exception.filter.ts` + spec; registered via `APP_FILTER`
  in `app.module.ts:145`, matching the existing `APP_GUARD` convention.
- Mapping: P2002→409 ALREADY_EXISTS · P2003→409 RELATED_RECORD_CONFLICT · P2025→404 NOT_FOUND ·
  P2034→503 WRITE_CONFLICT. Unmapped codes stay 500 and are logged with code+meta.
- `@Catch(Prisma.PrismaClientKnownRequestError)` makes preservation structural: an HttpException
  cannot reach the filter, so ~525 existing throws are provably unaffected (asserted in the spec
  by reading the `__filterCatchExceptions__` metadata).
- The 14 call-site handlers catch first and are untouched; several treat P2002 as idempotency
  success (`gamification.service.ts:150`, `achievements.service.ts:56`) and still do.
- Body is exactly `{message, code}`. Prisma's message/meta never leave the server (asserted).
- No i18n strings added: `errorMessage.ts:96-98` uses `defaultValue:''` so an unknown code
  falls through to the per-status Arabic sentence.
- Fail-before proof: filter file moved aside → suite fails `TS2307 Cannot find module`, 0 tests.
  Restored → 9/9 pass.
- Verification: tsc api OK, tsc web OK, build OK, suite 104/104 & 1548/1548 (baseline 103/103, 1539/1539).

### #3 detail — verification, not a fix
- Probe: read-only `GET /api/v1/health` on `darslyapi-production.up.railway.app`, 11 requests.
  No auth/payment/reset endpoint touched; no limit exhausted; no 429 produced.
- Observed `X-RateLimit-Limit: 120` throughout, `X-RateLimit-Remaining`:
  - no header:        119, 118, 117
  - fixed spoof:      116, 115, 114
  - 4 distinct spoofs:113, 112, 111, 110
  - multi-hop chain:  109
  One unbroken sequence → **a single bucket**. A spoofed `X-Forwarded-For` never
  created a fresh count, so **Railway's edge replaces the inbound header**.
- Redis was live (counter monotonic and persistent), so this is NOT the fail-open
  inconclusive case.
- Corrected a factual error in the review: `@nestjs/throttler`'s default tracker returns
  `req.ip`, not `req.ips[0]` (`throttler.guard.js:141-143`).
- `apps/api/src/common/trust-proxy.spec.ts` already proves the leftmost-XFF mechanism; it was
  written for the real production bug (non-monotonic remaining 15,19,17,16,19 before
  `trust proxy` was set). Left untouched — the adversarial case it omits is not reachable.
- **No code changed. Fix 3 closed as not-a-defect.**

### #2 detail — durable video packaging
- New `VideoJob` table (migration `20260925100000_video_jobs`, additive: 1 table + 2 enums).
  Partial unique index `VideoJob_active_per_asset_key ON (videoAssetId) WHERE status IN
  ('QUEUED','RUNNING')` — written in raw SQL because Prisma has no syntax for partial unique
  indexes; verified present in Postgres via pg_indexes.
- Claim = `FOR UPDATE SKIP LOCKED`, lease 5 min + heartbeat at half-lease, backoff 30/60/120s
  capped at 10 min, MAX_ATTEMPTS 3, RETRYABLE/TERMINAL.
- `main.ts` now calls `app.enableShutdownHooks()` — without it no `onModuleDestroy` fires on
  Railway's SIGTERM, so every drain (incl. AiJobWorker's existing one) was dead code. Prereq for #6.
- Both call sites are transactional: asset row + job row commit together.
- API contract unchanged; asset set to PROCESSING at enqueue so `/uploads/videos/:id/status`
  reads exactly as before.
- Own config: `VIDEO_WORKER_ENABLED=true`, `VIDEO_WORKER_CONCURRENCY=1` (NOT the AI worker's 3 —
  ffmpeg saturates a core on the container serving HTTP). Documented in `.env.example`.
- Fail-before proof: queue implementation moved aside → 4 suites fail `TS2307`, 0 tests. Restored → all pass.
- Verification: tsc api OK, tsc web OK, prisma validate OK, migrate status "up to date",
  build OK, 107/107 suites & 1581/1581 tests (baseline 104/104, 1548/1548).

### #5 detail — Tier 1 only (DB-side aggregation)
- **Correction of record:** the review's "174 of 211 findMany unbounded" counted *syntax*, not
  risk. Re-parsed with brace matching: 168 unbounded, but most are bounded by their WHERE.
  Verified-safe examples that were wrongly implied risky: `wallet.service.ts:53` (sibling query
  has `take:50`; the unbounded one is PENDING topups for one student), `wallet.controller.ts:141`
  (`paymentId IN (…)` from a `take:10` query), `playback.service.ts:292` (one student, open
  sessions, recent window). **Real risk set ≈ 9 sites, not 174.**
- Converted (all `findMany` → `count`/`aggregate`/`groupBy`):
  `analytics.service.ts` teacherOverview (4 scans) and academyOverview (2);
  `admin-analytics.service.ts:135` (platform-wide, widest read in the codebase);
  `gamification-analytics.service.ts` ×3 (busiest table); `admin-centers.service.ts:215`.
- **Key constraint discovered:** `count`/`aggregate`/`groupBy` are in `READ_ACTIONS`
  (`prisma.service.ts:72-79`) so they inherit the soft-delete filter; `$queryRaw` does NOT.
  Using raw SQL here would have silently started counting deleted rows. Asserted in the spec.
- Semantics preserved: all-time totals stay all-time; only the two 6-month charts read rows,
  now windowed. `netCents ?? amountCents` split into two aggregates and re-added.
- `teacherOverview` had **no test at all** before this; now has a contract spec pinning keys,
  types, and that totals carry no date filter.
- Verification: tsc api/web OK, prisma validate OK, build OK, 105/105 suites & 1551/1551
  (branch baseline main = 103/103, 1539/1539). No migration, no index change, no API change.

## Found while fixing

- **Migration `20260924100000_center_theme_grants` is timestamped in the future** (today is
  2026-09-22). Any migration authored before the 24th sorts *before* it, so a later-authored
  migration can be applied earlier than one that already ran — an ordering/drift hazard.
  Not renamed (already applied in environments); noted only. Reported by the user at Step 0.
- **`react-hooks/rules-of-hooks`: `useQuery` called conditionally** —
  `apps/web/src/pages/teacher/TeacherAnalyticsPage.tsx:463`. React requires an identical hook
  order every render; this can throw "Rendered more hooks than during the previous render".
  Real bug, previously invisible because the plugin was never installed.
- **5 genuine `exhaustive-deps` warnings** now visible for the first time (stale-closure risk).
- **Jest reports a worker leak**: "A worker process has failed to exit gracefully… tests leaking
  due to improper teardown". Pre-existing, appears on the full run, not investigated.
- **`apps/web/src/lib/api.ts:61` rejects a promise with a non-Error** (`prefer-promise-reject-errors`),
  in the 401-refresh path — loses the stack trace on refresh failure.
- **3 `await` on non-thenables** in `apps/web/src/lib/useDailyMeeting.ts:314,344,357` — dead awaits
  in live-meeting teardown; likely a misread of the Daily API surface.


## Final status — 2026-09-23

21 branches, all pushed and verified in sync with origin. Every branch is cut from `main`
except `fix/6-ai-worker-drain`, which is cut from `fix/2-video-durable-queue` because the
drain it adds is dead code without `app.enableShutdownHooks()` (which lands in #2).

### Deferred, each under a stated approval condition
| # | Title | Condition | Why |
|---|---|---|---|
| 5 (Tier 2) | Paginate 4 user-facing list endpoints | 1 — breaking contract | They return bare arrays the SPA `.map()`s; needs coordinated frontend work. The teacher directory also has **no `orderBy`**, so a stable sort is a prerequisite. |
| 9 | CSP + refresh token out of localStorage | 5 — security trade-off | Needs a separate origin (or per-response CSP) for generated academy sites, and moving the refresh token to an httpOnly cookie brings CSRF back. |
| 10 | Forgot-password enumeration | 1 + 2 — contract + product | The fix changes a 404 to a 200; the frontend currently shows "email not found". |
| 11 | `/payment-events` per-device keys + HMAC | 3 — infrastructure | Requires re-keying deployed Android devices. |
| 12 | Soft-delete `findUnique` | 6 — multiple safe approaches | See above: a blanket conversion is actively harmful. |
| 13 | Response/HTTP caching | 3 — new dependency | `@nestjs/cache-manager`. |
| 18 | One `Page<T>` envelope | 1 — breaking contract | Same blocker as 5 Tier 2. |
| 22 | Split the god files | 4 — large refactor | 1,763-line `CourseBuilderPage` with no frontend test harness. |
| 23 | Shared zod form schemas | 3 — new dependency in `apps/web` | |
| 29 | 13 `@Global()` modules | 4 — architecture | |
| 32 | `enableVersioning` | 6 | Interacts with the existing `api/v1` global prefix; two materially different routing shapes. |
| 34 | Student cosmetics override core classes | 6 | Rescoping the CSS needs visual verification; no browser harness available (playwright was pruned from node_modules). |
| 35 (confirm) | 25 native `confirm()` calls | 6 | Native confirm is browser-accessible; impact is aesthetic/RTL. Converting 25 destructive-action sites with no frontend tests is a poor risk trade. |
| 7 (remainder) | 11 remaining high CVEs | 4 — framework migration | All semver-major: NestJS 10→12, Vite 5→8. |


## Integration audit — 2026-09-23 (no merges performed)

- All 21 branches verified present on `origin` at the stated SHAs; all 21 merge-base = `origin/main`.
- `fix/6-ai-worker-drain` is **stacked on `fix/2`** (2 commits: `d49be3a` + `ba4dd8c`). Every
  other branch is a single commit.
- Cumulative merge simulated in a throwaway worktree: **20 of 21 merge cleanly in sequence.**
  The single conflict is `apps/api/prisma/schema.prisma` between **#15 and #2/#6**, and it is
  order-independent (reproduced both ways). Both add lines directly after `lesson Lesson?` in
  `model VideoAsset`: #2 adds `jobs VideoJob[]`, #15 adds `@@index([tenantId])`. Resolution is
  "keep both" — no semantic decision.
- **Migration ordering verified empirically**, not assumed. On a throwaway database, applying
  `20260925110000` + `20260925120000` first and *then* the older `20260925100000_video_jobs`
  succeeded: "All migrations have been successfully applied", no P3009. The three migrations are
  mutually independent (#15 and #28 never reference `VideoJob`), so merge order carries no
  migration hazard here.
- **CI defect found and fixed** (`fix/1` @ `2f351ef`): `npm test -- --maxWorkers=2` handed the
  flag to the outer npm, which ran a bare `jest` — the pin was a silent no-op. Proven with
  `--testPathPattern=zzz-does-not-exist` running all 1,539 tests before, and reporting
  "No tests found" after. Now `working-directory: apps/api` + `npx jest --maxWorkers=2`.
- Every CI step re-run locally after a real `npm ci` from `fix/1`, with CI's env and an
  unreachable `DATABASE_URL`: generate 0, validate 0, tsc api 0, tsc web 0, lint 0 (warn-only),
  format:check 1 (continue-on-error), test 0 (103/103, 1539/1539, 22s), build 0, audit 1
  (continue-on-error).


## Integration — 2026-09-23 (branch `integration/review-remediation` @ d768bf3, NOT merged to main)

- Base: exact `origin/main` @ `62caf66`. All 21 remediation branch tips verified as ancestors.
- **One conflict**, as predicted: `apps/api/prisma/schema.prisma`, `model VideoAsset`, between
  #15 and #2. Resolved mechanically by keeping **both** — `jobs VideoJob[]` and
  `@@index([tenantId])` — with `model VideoJob` intact (15 fields, 3 indexes). No semantics
  altered. Verified in a live database: `VideoAsset_tenantId_idx` present AND `VideoJob` table
  present with its partial unique index.
- #2 merged before #6; dependency verified (`enableShutdownHooks` present, both worker drains
  present, all 40 worker specs green together).

### Post-merge verification (all from the integrated tree)
| Check | Result |
|---|---|
| clean `npm ci` | OK — 610 packages, eslint/prettier/ioredis/supertest all present |
| prisma generate / validate | OK / valid |
| 85 migrations onto an EMPTY database | "All migrations have been successfully applied" |
| **migration drift** | **5 items — IDENTICAL on `origin/main`, byte for byte ⇒ PRE-EXISTING, not a merge regression.** The 3 new migrations add no drift of their own. |
| tsc api / web | OK / OK |
| lint | 612 warnings, **0 errors**, exit 0 |
| format:check | 523 files (continue-on-error, as designed) |
| **Jest** | **122/122 suites, 1726/1726 tests, 11/11 snapshots** |
| **e2e (#8)** | **1/1 suite, 24/24 tests** |
| production build | OK, 15.9s |
| #14 locale split intact | initial chunk carries 0 Arabic strings; `ar` chunk separate |
| Docker build + run | exit 0; runs as uid=1000(node), api+web dist present, prisma 5.22 available, /data/storage writable |
| CI workflow | 12 steps, correct triggers, Test step `cwd=apps/api` + `npx jest --maxWorkers=2` |

### Pre-existing issue, documented not masked
`prisma migrate diff` reports 5 drift items between the migration history and `schema.prisma`
(ChatMessage `replyToId` index, QuizAttempt `(quizId,studentId,voidedAt)` index, and three
column defaults on CosmeticItem/StudentCustomization/TeacherProfile). **The identical five
appear on `origin/main`**, so they predate all remediation work. They mean a database built by
replaying migrations differs slightly from one built by `prisma db push`. Not a blocker for
this merge; worth its own issue.


## PR #1 — real GitHub Actions run, 2026-09-23

- Pushed `integration/review-remediation` @ `d768bf3` (exact verified SHA; local == remote).
- PR: https://github.com/ahmed2003-code-py/darsly/pull/1 (`integration/review-remediation` → `main`),
  42 commits, 74 files, +6610 / -422. `mergeable: true`, `mergeable_state: clean`.
- **CI run 35817136977 — conclusion: SUCCESS**, first attempt, no fixes needed. Node v20.20.2,
  `ubuntu-latest`, ~3 minutes.

| Step | Real result on the runner |
|---|---|
| Install (`npm ci`) | 915 packages in 20s, no errors |
| Generate / Validate Prisma | pass / pass |
| Typecheck API / web | pass / pass |
| Lint | 612 problems, **0 errors** |
| Format check | exit 1, 523 files — **masked by `continue-on-error`, by design** |
| **Test** | **122/122 suites, 1726/1726 tests, 11/11 snapshots** |
| Build | pass |
| Audit | exit 1, 32 vulns (11 high) — **masked by `continue-on-error`, by design** |

- The #1 CI fix is confirmed on a real runner: the step header reads
  `Run npx jest --maxWorkers=2` from `apps/api` — the flag reaches Jest.
- CI's 1726/1726 matches local verification exactly.
- `origin/main` still `62caf66` — untouched.


## MERGED TO MAIN — 2026-09-23

- PR #1 merged with a merge commit: **`fb8845138a47109d2066da213827854353419c93`**.
  `origin/main` now points at it. All 21 remediation branch tips are ancestors of `main`.
  Branches deliberately NOT deleted.
- Railway deployment **`e9faa38a-d5eb-4a2e-9543-58e16d49be95` — SUCCESS**, started 07:16:08 +03:00,
  new build serving by 07:20:10.
- Migrations succeeded. `scripts/start.sh` only `exec`s node after `prisma migrate deploy` passes
  and otherwise refuses to boot on a drifted schema; the log line
  `Darsly API listening on http://localhost:8080` plus `/health/ready -> database: ok` is the proof.
  No P3009/P3006.

### Production smoke — all green
| Area | Result |
|---|---|
| health / live / ready | 200 / 200 / 200; `database:ok redis:ok storage:ok`; `/health` keys unchanged |
| auth | no token → 401; garbage token → 401; wrong credentials → 401 `Invalid credentials` |
| role separation | admin/teacher/student routes all 401 without a token (401 before 403 — guard order) |
| public JWT (#27) | public routes serve 200 anonymously AND with a garbage token |
| video/job | video status route 401 without a token |
| payments/wallet | `/wallet` 401, `/teacher/wallet` 401, `/payments/mine` 401 |
| web | `/` and SPA fallback `/login` both 200 |
| **#14 in production** | **initial chunk 98 KB (was ~333 KB), 0 Arabic strings; `ar` chunk served separately (134 KB)** |
| **#19 in production** | `x-request-id` header present on every response |
| **#30 in production** | `/health/live` and `/health/ready` live; `/health` byte-compatible |
| helmet | HSTS, nosniff, X-Frame-Options present |
| throttler | `x-ratelimit-*` present, counter decrements monotonically (Redis-backed) |
| #3 reconfirmed in prod | spoofed `X-Forwarded-For` still shares one bucket (115 → 114) |

### Noted, not acted on
- Railway warns `railway.json` config-as-code is deprecated in favour of `.railway/railway.ts`.
  Pre-existing, unrelated to this merge, and an infrastructure decision — not touched.


## Post-merge follow-ups — 2026-09-23

### 1. E2E wired into CI — DONE
- `ci/e2e-step` @ `92cf51e`, PR #2. One file, +12 lines: a dedicated step after the unit step.
- CI run 35818439486 **success**; on the runner: unit 122/122 & 1726/1726 (unchanged), **e2e 24/24**.
- The suite cannot reach production: in-process Nest + supertest on an ephemeral local port,
  `PrismaService` stubbed via `useValue`, own JWT secret.
- **PR #2 is open, not merged** (merging redeploys Railway via `watchPatterns: **`).

### 2. Prisma drift — INVESTIGATED, no migration written
**Direction is the opposite of the review's assumption.** Production and the migration history
agree on all five; `schema.prisma` under-declares. A "corrective migration" would DROP two
useful indexes and three defaults. Fix is schema-only. Verified on a scratch copy:
`migrate diff` → **"No difference detected."** See memory `prisma-schema-drift`.
Production was inspected READ-ONLY (SELECTs against pg_catalog/information_schema + COUNT).


## Drift resolved + e2e in CI — merged 2026-09-23

- PR #2 merged: **`82246b2918d3d8fe47ec6a1f99aa9e9f23d41275`**; `origin/main` now points at it.
  Two files only: `.github/workflows/ci.yml` (+12) and `apps/api/prisma/schema.prisma` (+11/-8).
- **`prisma migrate diff` → "No difference detected."** (was 5 differences).
- **Migrations unchanged and provably so**: 85 folders before and after, combined md5 of every
  `migration.sql` identical at `dbfb716633e36541a5c9f84b3fec775b`. No migration file created or edited.
- CI run 35819893399 **success** — every step, incl. unit 1726/1726 and e2e 24/24.
- Railway deployment **`1ae8953a-5185-48bd-ac0c-bff4ebe98a66` — SUCCESS**.
  `/health`, `/health/live`, `/health/ready` all 200; `database:ok redis:ok storage:ok`.
- Deployed container carries the change (schema greps match) and still ships 85 migrations.
- **Production database NOT mutated** — verified read-only after deploy: identical 7 indexes
  (incl. the deliberately-kept 2-column `QuizAttempt_quizId_studentId_idx`), identical 3 column
  defaults, 85 migrations applied, latest still `20260925120000_wallet_topup_single_pending`.
