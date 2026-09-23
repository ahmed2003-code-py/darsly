# Review notes (resumable) — darsly
Repo: /home/ahmedeldeeb/darsly · branch main · HEAD ca4e6d9

## Phase 1 — Reconnaissance  [DONE]
- npm workspaces monorepo: `apps/api` (NestJS 10), `apps/web` (React 18 + Vite 5), `packages/shared-types`. Also `android/` (Kotlin SMS listener), `docs/`, `scripts/` (61 hand-written audit/smoke .mjs).
- Size: api 429 TS files / 66,406 lines; web 161 files / 33,574 lines; shared-types 626 lines.
- API entry `apps/api/src/main.ts`: validateConfig() first, helmet (CSP off), trust proxy, JSON body limit, CORS from ALLOWED_ORIGINS, global prefix `api/v1`, global ValidationPipe(whitelist+forbidNonWhitelisted+transform), Redis Socket.IO adapter, Swagger **non-prod only**.
- 41 API feature modules (academy, academy-ops, academy-site, admin, payments, payouts, playback, video, xpay, wallet, live, gamification…).
- Deploy: single Docker image serves API + built SPA (`Dockerfile`), Railway (`railway.json`, DOCKERFILE builder, watchPatterns `**`). Start = `apps/api/scripts/start.sh` → `prisma migrate deploy` (with P3009 self-heal) → node.
- `.env` exists locally but is gitignored and NOT tracked (only `.env.example`) — verified `git ls-files`.
- **No CI**: no `.github/` at all.
- **No linter/formatter config anywhere**: no eslintrc/eslint.config/prettierrc (find, depth 3).
- **Web has zero test tooling** (no jest/vitest/testing-library in apps/web/package.json). API has 103 `*.spec.ts`; `test:e2e` script points at `apps/api/test/jest-e2e.json` but **`apps/api/test/` does not exist** → `npm run test:e2e` is dead.

## Phase 2 — Architecture  [DONE]
- Style: **modular monolith**, NestJS feature modules (41), deployed as a single service that also serves the SPA (`app.module.ts:54-83` ServeStaticModule with hashed-asset immutable caching + `no-cache` index.html).
- Layering: Controller → Service → PrismaService. 60 controllers / 90 services; **13 controllers inject PrismaService directly** (leak of the data layer into transport): catalog, notifications, gamification, payments/wallet, playback, playback/notes, health, admin, teachers, uploads, gamification-admin, security, enrollments/coupons.
- Global guard chain, order declared explicitly `app.module.ts:133-137`: ThrottlerGuard → JwtAuthGuard → RolesGuard. Route-level guards add academy scope: `AcademyMembershipGuard` → `PermissionGuard` (`apps/api/src/academy/guards/`).
- Multi-tenancy is two orthogonal ids, documented at `apps/api/src/courses/courses.service.ts:263-270`: `academyId` = organisation acting in; `tenantId` = authoring TeacherProfile. Resolved into an `AcademyContext` (`academy/academy-context.ts:12-17`) with a capability set (`academy/permissions.ts:10-31`, 18 capabilities).
- Data: Prisma 5 + Postgres. **99 models, 3,094-line schema, 82 migrations** (hand-written SQL folders).
- Branding middleware `AcademyThemeMiddleware` injects the academy palette into index.html before the SPA boots (`app.module.ts:146-156`).
- Realtime: Socket.IO with a Redis adapter for cross-replica fan-out (`main.ts:68-72`, `redis/redis-io.adapter.ts`).
- Video: encrypted HLS. Session control is bearer-authed; playlist/segment/key routes are `@Public()` and authenticated by a signed URL token + optional Referer allow-list (`playback/playback.controller.ts:57-62,124-135,196-199`).

## Phase 3 — Tech stack & dependencies  [DONE]
- `npm audit`: **37 vulns — 0 critical, 15 high, 18 moderate, 4 low**; every one reports `fixAvailable`.
- Runtime-reachable highs (production path):
  - `multer` (via `@nestjs/platform-express`) — DoS via incomplete cleanup + resource exhaustion. Project DOES accept multipart uploads (`uploads.controller.ts`, `FileInterceptor` in `courses/teacher-courses.controller.ts:14-16`).
  - `path-to-regexp` (via `@nestjs/serve-static`) — ReDoS on route matching; serve-static is enabled in prod (`app.module.ts:60-83`).
  - `react-router` (frontend runtime) — open redirect via backslash in `<Link>`/`useNavigate`; this app takes `?redirect=` params (`apps/web/src/lib/redirect.ts`).
  - `lodash` (via `@nestjs/config`), `file-type` (via `@nestjs/common`), `nanoid`, `qs`, `brace-expansion`.
- Build/dev-only highs: `@nestjs/cli`/`@angular-devkit`, `vite`, `esbuild`, `postcss`, `browserslist`, `glob`, `tmp`, `js-yaml` (swagger, non-prod only), `webpack`.
- Major versions behind: NestJS 10 → 12 (whole platform), **Prisma 5.22 → 7.10 (two majors)**, React 18 → 19, react-router 6 → 7, Vite 5 → 8, Tailwind 3 → 4, zustand 4 → 5, i18next 23 → 26, jest 29 → 30, TS 5.9 → 7.
- Stack is coherent and conventional for the problem: NestJS+Prisma+Postgres, React+Vite+Tailwind+TanStack Query+Zustand, argon2 for passwords, helmet, class-validator, socket.io+Redis, ffmpeg HLS, Resend mail, OpenAI for the site generator, Daily for live classes, Deepgram for transcription.

## Phase 8 — Testing  [DONE]  (run: `cd apps/api && npx jest --maxWorkers=2`)
- **Result: 103 suites → 101 passed, 2 failed. 1531 tests → 1521 passed, 10 failed. 11 snapshots passed. ~17s.**
- Coverage (jest --coverage, instrumented files only): **Statements 66.21% (6878/10387), Branches 53.12%, Functions 59.28%, Lines 68.31%**.
- Failure 1 — `src/gamification/gamification.integration.spec.ts`, 10 tests. Cause: local dev DB is behind on migrations — `The column User.adminThemePreference does not exist in the current database`. **Environmental, not a product bug.** BUT it exposes a test-design flaw: the skip-guard probes only `prisma.xpRule.count()` (`gamification.integration.spec.ts:53-60`), so connectivity passes while schema drift is undetected and the suite fails instead of skipping.
- Failure 2 — `src/redis/redis-throttler-storage.service.spec.ts`: suite fails to compile, `Cannot find module 'ioredis'`. `ioredis` IS declared (`apps/api/package.json:42`) but is **not present in node_modules** — local install is out of sync with the manifest. Same root cause makes `@socket.io/redis-adapter` unresolvable.
- **`npm run test:e2e` is dead**: script points at `apps/api/test/jest-e2e.json`; `apps/api/test/` does not exist. supertest + @types/supertest are installed but unused.
- **Web app has zero tests** — no jest/vitest/testing-library in `apps/web/package.json`.
- Modules with ZERO spec files (>300 lines): `chat` (624), `wallet` (455), `teachers` (452).
- Best-tested: academy-site (20 specs), payments (12), academy (7), admin (6), academy-ops (6).
- Test quality is high where present — specs assert real invariants (idempotency, concurrency, tenancy isolation), not trivia. e.g. `courses/course-scope.spec.ts`, `academy/academy-subjects.service.spec.ts`. Integration specs deliberately run against real Postgres to prove DB-level guarantees mocks can't.
- 61 hand-written audit/smoke scripts in `scripts/` (audit-idor, verify-authz-matrix, check-finance-integrity…) — a parallel, manual QA harness, not wired into any automated run.

## Phase 4 — Frontend (subagent, verified samples)  [DONE]
- Structure: pages/ (role-foldered) + components/ + lib/ (40 data-hook modules) + stores/ (2 files, 98 lines). Good separation.
- God-pages: CourseBuilderPage 1763 lines / 29 useState; StudioPage 1479; GradingPage 1038; SecureVideoPlayerPage 842; MessagesPage 738.
- State: zustand only for identity (`stores/auth.ts`, `stores/staffAcademy.ts`); react-query for everything server-owned; cache purged on sign-out (`lib/queryClient.ts:71-82`) and on identity change (`stores/auth.ts:38-42`). Disciplined.
- **Tokens (access AND refresh) persisted in localStorage** via zustand persist key `darsly-auth` — VERIFIED `apps/web/src/stores/auth.ts:8,11,13,44`.
- Routing: 66 flat routes in App.tsx; `RequireAuth` (App.tsx:91-112) exact role match, no super-admin bypass (deliberate). Code-splitting IS thorough — every page but LoginPage via `lazyPage` with 3-attempt retry (`lib/lazyPage.ts:17-39`).
- API: single axios instance, Bearer + X-Academy-Id interceptors, single-flight 401 refresh with `_retried` guard (`lib/api.ts:19-62`). Global mutation-error toast via MutationCache (`lib/queryClient.ts:27-37`); **query errors have no global surface**.
- Forms: no schema library at all (no zod/yup/react-hook-form). Hand-rolled checks, client-only, no shared contract with the API.
- Styling: 4 layered theme systems over CSS vars (platform `--c-*`, academy branding, student cosmetics `--s-*`/`data-s-*`, admin `--adm-*`). Powerful but hard to reason about; cosmetics restyle `.btn-primary`/`.card` globally (index.css:580-650).
- a11y: shared `Modal` (`components/ui.tsx:143-172`) has NO role="dialog"/aria-modal/focus-trap/Escape/focus-restore. 3 imgs without alt. 25 native `confirm()`.
- Bundle (real `vite build`, exit 0): `hls-*.js` **522 KB** (lazy, but pulled into CourseBuilderPage), `index-*.js` **333 KB initial** of which ~286 KB is BOTH locale JSONs statically imported (`i18n/index.ts:3-4`), MeetingPage 262 KB, CSS 105 KB.
- ErrorBoundary at root with a good chunk-load-error → one-shot-reload path (`components/ErrorBoundary.tsx:23-36,71-89`).

## Phase 5 — Backend (subagent, verified samples)  [DONE]
- **No global exception filter, no interceptor** — VERIFIED by grep (`useGlobalFilters|ExceptionFilter|@Catch|NestInterceptor` → zero hits in src). **P2025 handled nowhere** (grep → zero hits) ⇒ update/delete on a missing row = 500, not 404. P2002 handled ad hoc in 6 places, P2034 in 3.
- **No `enableShutdownHooks()`** — VERIFIED zero hits.
- Validation is excellent: 123 of 124 `@Body()` params have a class-validator DTO; only `academy-site/site/academy-site.controller.ts:41` is `unknown`. Zero `any`.
- No `forwardRef` anywhere — acyclic module graph. But **13 `@Global()` modules**, so boundaries are declarative only.
- Versioning is cosmetic: `setGlobalPrefix('api/v1')` only, no `enableVersioning`, no `@Version`.
- **Four incompatible list response shapes** across modules (`courses.service.ts:255-259` vs `audit.service.ts:24-26` vs `academy-ops/groups.service.ts:60` vs bare arrays in `catalog.controller.ts:62`); `notifications.controller.ts:26-31` has a hard `take: 30` with no paging.
- Controllers with real domain policy inside: `enrollments/coupons.controller.ts:70-115`, `payments/wallet.controller.ts` (16 direct prisma calls).
- God-services: courses 1224, live 1059, challenges 970, manual-payments 960, quizzes 913 lines.
- Soft delete centralised in a Prisma `$use` middleware over a 40-model allow-list (`prisma/prisma.service.ts:113-134`) but **`findUnique` is deliberately excluded** (:118) ⇒ 49 findUnique calls can return deleted rows. `$use` is deprecated in Prisma 5.
- Jobs: AI worker is a real queue (FOR UPDATE SKIP LOCKED, lease+heartbeat, retry classes, attempt cap — `academy-site/jobs/ai-job.worker.ts`). **Video transcoding is fire-and-forget** — VERIFIED `video/video-processing.service.ts:29-33` `void this.process(...).catch(log)`; no persistence, no retry, no lease ⇒ a deploy mid-transcode strands the asset in PROCESSING forever.
- Config: `@nestjs/config` global but **ConfigService never injected**; ~138 bare `process.env` reads. `common/config.validation.ts` fail-fast covers ~12 critical keys.
- Logging: Nest `Logger` in 37 files, only 5 legit `console.*`. **No structured logger, no correlation/request id** (grep → zero).

## Phase 7 — Security (subagent, verified samples)  [DONE]
- No SQL injection: every `$queryRaw` is a tagged template; only `*Unsafe` is in `common/demo-seed.ts:161` behind ALLOW_RESEED + confirm phrase (`admin/admin.controller.ts:43-52`).
- Shell use is argv-array `spawn`/`execFile` only — never a shell string (`video/transcode.service.ts:141`, `video/youtube-import.service.ts:291`, `academy-site/media/academy-media.processor.ts:98`).
- Auth: argon2id + constant-time dummy hash (`auth/auth.service.ts:33,296`), refresh rotation WITH reuse detection that revokes the session (`auth/token.service.ts:100-105`), role/status re-read from DB on refresh.
- **No IDOR found** across 10+ sampled controllers; scope always from `@CurrentUser()`/`@CurrentAcademy()`. `X-Academy-Id` resolves only to an ACTIVE membership (`academy/guards/academy-membership.guard.ts:23-28`).
- **VERIFIED: no custom throttler `getTracker`** (grep → only the two app.module lines). With `app.set('trust proxy', true)` (`main.ts:31`), @nestjs/throttler's default tracker is `req.ips[0]` = leftmost client-supplied XFF ⇒ spoofable throttle key. [Unverified] whether Railway's edge strips inbound XFF.
- Forgot-password returns distinct 404 EMAIL_NOT_FOUND / 403 ACCOUNT_DISABLED ⇒ enumeration (`auth/auth.service.ts:339-344`).
- CSP disabled (`main.ts:39`) on the SAME origin that serves AI-generated academy HTML (`academy-site/public/public-site.controller.ts:37`) + refresh token in localStorage ⇒ any escaping miss = account takeover.
- `/payment-events` = static shared key, constant-time compared, `externalId` de-dupe, but no timestamp/nonce binding (`payments/payment-events.controller.ts:66-81`). Key ships on Android devices.
- Upload MIME checks trust the declared type (no magic bytes) in `uploads/uploads.controller.ts:44-47,82-86`; impact bounded by Content-Disposition: attachment + nosniff.
- Public-route JWT path omits `algorithms` AND the revocation check (`common/guards/jwt-auth.guard.ts:36-39`). Not forgeable (string secret ⇒ HMAC-only in jsonwebtoken) but a revoked session still gets viewer-aware data.
- XPay: raw-body HMAC, fail-closed with no secret, constant-time compare, re-reads the session from the provider before settling, idempotent conditional flip (`payments/xpay/xpay.service.ts:171-245`). No client-supplied amounts anywhere.

## Phase 6 — Performance  [DONE]
- **174 of 211 `findMany` calls have no `take`/cursor** (script-counted). Sampled: `enrollments/enrollments.service.ts:323,346,350,395`, `student/student-extras.service.ts:36`, `enrollments/coupons.controller.ts:60`.
- `notifications.controller.ts:26-31` caps at `take: 30` with no way to page further — silently truncates.
- Indexes: 108 `@@index` + 27 `@@unique` over 99 models — generally good. Postgres does NOT auto-index FKs; models with FK columns and no index: **Attachment (lessonId)**, **VideoAsset (tenantId)**, **QuizQuestion (quizId)**, TeacherGrade, StudentInterest, BundleItem, StudentGamification, StudentCustomization, AcademyProfileFacts, Announcement, PayoutMethodSaved. LedgerTransaction/Invoice have inline `@unique` on paymentId/payoutId so those lookups are covered.
- **No response/HTTP caching at all** (no CacheModule/cache-manager). Redis is used ONLY for throttler storage + Socket.IO fan-out — not as a cache.
- Frontend: 333 KB initial JS of which ~286 KB is both locale files; 522 KB hls.js chunk reachable from the course builder.
- Video transcode runs in-process (ffmpeg spawn) on the same container as the API — CPU contention with request serving.

## Phase 9 — Code quality & DevOps  [DONE]
- **No linter or formatter anywhere**: no eslintrc / eslint.config / prettierrc; no `"lint"` script in any package.json. VERIFIED.
- TypeScript `strict: true` in all three tsconfigs; web also sets `noUnusedLocals`/`noUnusedParameters`. API relaxes only `strictPropertyInitialization` (normal for Nest DI).
- `any` escapes: 58 in apps/api/src (non-spec), **172 in apps/web/src** — the web side leans on `any` for API responses because there are no generated client types.
- **Zero TODO/FIXME/HACK markers** in src — unusual and good.
- Largest files: CourseBuilderPage.tsx 1763, StudioPage.tsx 1479, courses.service.ts 1224, live.service.ts 1059, GradingPage.tsx 1038.
- Comment quality is a genuine standout: decisions are documented with the observed failure that motivated them (`main.ts:20-30`, `prisma/prisma.service.ts:122`, `payments/manual-payments.service.ts:171`).
- **No CI/CD**: no `.github/`. Nothing runs tests, typecheck or build on push. Deploy = push to main → Railway rebuilds the Dockerfile.
- Health check: `GET /api/v1/health` does a real `SELECT 1` (`health/health.controller.ts:13-16`) — liveness+DB, but no Redis/storage check and no readiness/startup split.
- Observability: no metrics, no tracing, no error reporter (no Sentry/OTel grep hits), no request id. Logs are unstructured Nest Logger lines.
- Docker: single-stage `node:20-slim`, `COPY . .` before `npm ci` (no layer caching for deps — every source change reinstalls everything), devDependencies kept in the final image, runs as root. `yt-dlp` deliberately unpinned (documented reason).
- Environment separation: one `.env` shape for all envs; `config.validation.ts` enforces the prod-only requirements at boot.
- `railway.json` uses `watchPatterns: ["**"]` so any change triggers a deploy.
