# درسلي — Darsly

Arabic-first EdTech marketplace connecting private teachers with their students:
recorded/live lessons, best-in-class content protection for teachers, a frictionless
student experience, and a built-in payments/accounting system. Primary locale is
Egyptian Arabic (full RTL, EGP currency); English is the fallback.

## Monorepo layout

```
darsly/
├── apps/
│   ├── api/            NestJS + Prisma (PostgreSQL) — REST API + Socket.io
│   └── web/            React + TS + Vite + Tailwind (RTL-aware) — students, teachers, admin
├── packages/
│   └── shared-types/   Enums & API contracts shared by api and web
├── scripts/            smoke-auth.sh + smoke-phase2.sh — end-to-end API verification
├── docker-compose.yml  postgres (5434) + minio (9000/9001, S3-compatible dev storage)
└── .env.example
```

## One-command dev setup

```bash
cp .env.example .env && cp .env.example apps/api/.env
docker compose up -d postgres     # minio too once the video pipeline lands (Phase 3)
npm install
npm run db:migrate                # prisma migrate dev
npm run db:seed                   # super admin + 2 teachers + 5 students + courses
npm run dev:api                   # http://localhost:4000  (Swagger: /api/docs)
npm run dev:web                   # http://localhost:5173
```

Verify the auth/RBAC layer end-to-end at any time:

```bash
bash scripts/smoke-auth.sh        # 18 checks: auth, RBAC, session control
bash scripts/smoke-phase2.sh      # 37 checks: discovery, course CRUD, tenant
                                  # isolation, uploads, coupons, enrollments
```

### Seeded dev accounts

| Role | Login | Credential |
|---|---|---|
| Super admin | `admin@darsly.app` | `Admin@12345` |
| Teacher (math, 20% commission) | `khaled@darsly.app` | `Teacher@12345` |
| Teacher (chem, 15%, auto-approve) | `noura@darsly.app` | `Teacher@12345` |
| Teacher (english, `language=en`) | `david@darsly.app` | `Teacher@12345` |
| Teacher (PENDING — hidden from discovery) | `pending@darsly.app` | `Teacher@12345` |
| Students ×5 | `+201011111111` … `+201055555555` | OTP — dev universal code `0000` |

Seeded coupons: `WELCOME20` (khaled, 20% off) · `CHEM50` (noura, 50 EGP off the chem course).

`OTP_DEV_MODE=true` logs OTP codes to the API console instead of sending SMS and
accepts `0000` universally. **Never enable in production.**

## Architecture decisions

- **NestJS + TypeScript (not FastAPI):** one language end-to-end; `packages/shared-types`
  is imported by both the API and the React app so enums/contracts can't drift;
  Socket.io (Phase 4 chat/notifications) is first-class; Prisma migrations are
  reviewable SQL.
- **PostgreSQL + Prisma:** the full ERD (identity, tenancy, catalog, content,
  enrollment, security forensics, double-entry ledger, assessment, comms, audit)
  is defined up front in `apps/api/prisma/schema.prisma` so later phases add code,
  not schema churn.
- **Multi-tenancy = `tenantId` scoping:** a tenant is a `TeacherProfile`. Every
  teacher-owned row (courses, coupons, payouts, security events…) carries
  `tenantId`; teacher JWTs embed their `tenantId` and all tenant queries filter by it.
  Shared-schema scoping (vs schema-per-tenant) fits thousands of small tenants and
  keeps cross-tenant admin analytics cheap.
- **Money:** integer piasters (1 EGP = 100), never floats. Every financial fact is a
  balanced double-entry `LedgerTransaction` (immutable; corrections are new
  ADJUSTMENT transactions).
- **Auth:** short-lived access JWT (15 min) + rotating refresh token bound to a
  `DeviceSession` row (argon2-hashed). Rotation reuse ⇒ session revoked (stolen-token
  defense). Device cap enforced at login: exceeding `MAX_CONCURRENT_SESSIONS_DEFAULT`
  kicks the oldest device. RBAC via global guards (`@Roles`, `@Public`); SUPER_ADMIN
  passes all role checks; every privileged mutation writes an `AuditLog` row.
- **Design system:** tokens in `apps/web/tailwind.config.ts` are extracted verbatim
  from the authoritative Stitch design export (indigo `#422EC7`/`#5B4CE0` +
  teal `#2DD4BF`, layered off-white surfaces, 16/24px radii, indigo-tinted shadows,
  Cairo headings + Tajawal body, RTL-first with sidebars on the right).

## SECURITY — real barriers vs. deterrents (read this honestly)

**Fully preventing screen capture on the web is impossible.** A second phone camera
pointed at the screen defeats every technical measure. Darsly's goal is layered
**deterrence + forensic traceability**: make leaking hard, risky, and traceable to
the exact student and session.

**Real barriers (enforced server-side):**
- Encrypted HLS (AES-128) only; raw MP4 keys are never exposed by the API (Phase 3).
- Per-user, short-lived signed URLs; per-session encryption keys, rotated.
- Device binding + concurrent-session cap (**live now** — 3rd login kicks the oldest
  device and its tokens die immediately, verified by `scripts/smoke-auth.sh`).
- Refresh-token rotation with reuse detection (**live now**).
- Per-lesson view caps and time-window access; enrollment revocation (schema ready).
- Playback forensics: every play is logged (who/when/IP/device/watch pattern) with
  anomaly detection for concurrent multi-IP playback and scripted access (Phase 3).

**Deterrents (client-side, best-effort — documented as such):**
- Roving forensic watermark burned into the player overlay: student name + phone +
  watermark ID + live timestamp. A leaked clip's watermark ID resolves back to the
  exact student + session via the teacher's Leak-Trace tool (Phase 3).
- DevTools detection, tab-blur pause + blur overlay, right-click/save/PiP blocking.
  These raise the effort bar; they do not stop a determined attacker.
- `IDrmProvider` adapter (EME/Widevine/PlayReady/FairPlay stubs) so a real multi-DRM
  provider (VdoCipher/Gumlet/Bunny) can be plugged in without refactoring (Phase 3).

## Build phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffolding, full DB schema, auth (OTP + password), RBAC, sessions, seed, web shell | ✅ done & verified |
| 2 | Teacher/course/lesson CRUD (units, drip, free preview, pricing, coupons, uploads), student enrollment lifecycle (quote→request→approve/reject/revoke, auto-approve, subscriptions, bundles), discovery + public profiles, all React screens | ✅ done & verified |
| 3 | Secure video pipeline (ffmpeg→AES-HLS), watermarked hardened player, session/device control | ⏳ next |
| 4 | Chat (Socket.io), notifications, progress tracking, student comfort | |
| 5 | Payments ledger, payouts, admin dashboards, teacher security tab | |
| 6 | Quizzes, reviews, certificates, tests, polish | |

## Deployment (Railway — single service + Postgres)

The site deploys as **one service**: the api build also builds the web app,
and the API serves `apps/web/dist` at `/` (SPA fallback; API stays under
`/api`). Web calls are same-origin in production — no CORS / `VITE_API_URL`.

- Service build command: `npm run build --workspace=@darsly/api`
- Service start command: `npm run start --workspace=@darsly/api`
  (runs `prisma migrate deploy` before boot)
- Required variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`,
  `JWT_REFRESH_TTL`, `OTP_*`, `MAX_CONCURRENT_SESSIONS_DEFAULT`,
  `ALLOWED_ORIGINS` (the public domain)
- Seed once from a dev machine:
  `DATABASE_URL=<DATABASE_PUBLIC_URL> npm run db:seed --workspace=@darsly/api`
- ⚠ `OTP_DEV_MODE=true` accepts the universal code `0000` — demo only.
- ⚠ Uploaded files live on the service's ephemeral disk until the Phase 3
  S3/MinIO pipeline; they do not survive redeploys.

## API docs

Swagger UI at `http://localhost:4000/api/docs` (OpenAPI 3), grouped by tag
(`auth`, `catalog`, `teachers`, `courses`, `enrollments`, `coupons`, `uploads`,
`health`; grows each phase).

### Phase 2 surface (summary)

- **Public**: `GET /teachers` (search + subject/grade/price/rating/language
  filters, sort, pagination), `GET /teachers/:slug` (profile + courses +
  reviews), `GET /courses/:id` (viewer-aware curriculum: free-preview always
  open, drip/enrollment lock state per lesson), `POST /enrollments/quote`
  (price + coupon validation).
- **Teacher** (`TEACHER` role, tenant-scoped — cross-tenant ids 404):
  course/unit/lesson CRUD + reorder, publish guard (needs ≥1 lesson), bundle
  composition, drip scheduling (fixed date or N days after enroll), coupons
  CRUD, enrollment approve/reject/revoke, video/attachment uploads
  (`storage/` on disk until the Phase 3 HLS pipeline), `PATCH /teacher/profile`.
- **Student**: `POST /enrollments` (auto-approve honors course/teacher policy;
  monthly subscriptions get a 30-day window; bundle activation unlocks child
  courses), `GET /enrollments/mine`, attachment downloads gated by enrollment.
- **Web**: role-routed React screens — discovery, teacher profile, course
  page with coupon quote + enroll, my-courses (student); dashboard, course
  list, curriculum builder with drip/preview/upload progress, approval queue,
  coupons (teacher). RTL-first, tokens from the design system.

## Dev notes

- Darsly Postgres runs on **5434** (5432/5433 were taken on the dev machine).
- Vite watches via polling by default here (Linux inotify-instance exhaustion);
  set `VITE_NO_POLLING=1` for native watchers, or raise
  `fs.inotify.max_user_instances` (needs sudo) and use native watching.
