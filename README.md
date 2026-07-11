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
bash scripts/smoke-phase3.sh      # 21 checks: encrypted-HLS transcode, signed
                                  # delivery, gated key, access control, anomaly
                                  # (needs ffmpeg + a sample video; see the script)
```

`ffmpeg` and `ffprobe` must be on PATH for the video pipeline (`apt-get install ffmpeg`).

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

**Real barriers (enforced server-side, all live):**
- Encrypted HLS only: uploads are transcoded (ffmpeg) to AES-128 HLS; the raw MP4
  source is deleted after packaging and is never served — the API only ever hands
  out encrypted segments + playlists.
- Per-user, short-lived HMAC-signed URLs (`SIGNED_URL_TTL_SECONDS`) scoped to one
  asset + session; the AES key is served ONLY to a live, watermarked session by a
  dedicated key endpoint, never bundled into the media. Keys rotate
  (`HLS_KEY_ROTATION_SECONDS`). Optional Referer/domain lock (`ALLOWED_ORIGINS`).
- **Honest scope:** AES-128 clear-key gates the *stream* with real server-side
  access control; it is NOT hardware DRM (no Widevine/PlayReady/FairPlay robustness
  or HDCP). The `IDrmProvider` adapter has those vendor providers stubbed so a
  licensed multi-DRM service (Gumlet/Bunny/VdoCipher) drops in without refactoring.
- Device binding + concurrent-session cap (3rd login kicks the oldest device and its
  tokens — and its playback keys — die immediately; `scripts/smoke-auth.sh`).
- Refresh-token rotation with reuse detection.
- Per-lesson view caps + time-window access (lesson expires N days after first
  unlock) + drip unlock; enrollment revocation kills playback mid-session.
- Playback forensics: every session logs who/when/IP/device/watch pattern with
  anomaly detection for concurrent multi-IP playback and scripted rapid-seek
  (→ `SecurityEvent` + teacher/student notification). Storage is pluggable
  (`STORAGE_DRIVER=local|s3`) behind one interface.

**Deterrents (client-side, best-effort — documented as such, NOT protection):**
- Roving forensic watermark burned into the player overlay: student name + masked
  phone + watermark ID (`DRS-…`) + live timestamp, repositioned every few seconds so
  it can't be cropped out. A leaked clip's watermark ID resolves back to the exact
  student + session (Leak-Trace, Phase 5 admin UI). A steganographic session token
  is also issued for invisible tracing.
- DevTools-open detection → pause + blur + server report; tab-blur/visibility pause +
  blur overlay; right-click/select/drag/save-shortcut/PiP blocking. These raise the
  effort bar; **fully preventing screen capture on the web is impossible** — a second
  camera defeats every measure. The goal is deterrence + traceability, not a guarantee.

## Build phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffolding, full DB schema, auth (OTP + password), RBAC, sessions, seed, web shell | ✅ done & verified |
| 2 | Teacher/course/lesson CRUD (units, drip, free preview, pricing, coupons, uploads), student enrollment lifecycle (quote→request→approve/reject/revoke, auto-approve, subscriptions, bundles), discovery + public profiles, all React screens | ✅ done & verified |
| 3 | Encrypted-HLS pipeline (ffmpeg→AES-128), signed expiring URLs + per-session gated keys, DRM adapter (native + Widevine/PlayReady/FairPlay stubs), storage abstraction (local/S3), device + views-cap + time-window access control, multi-IP/rapid-seek anomaly flags, roving forensic watermark + hardened React player | ✅ done & verified |
| 4 | Chat (Socket.io), notifications, progress tracking, student comfort | ✅ done & verified |
| 5 | Double-entry ledger, wallet + invoices, payouts (teacher+admin), admin console (overview/approvals/payouts/security/audit), teacher security tab + Leak-Trace | ✅ done & verified |
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
