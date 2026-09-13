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
├── android/            Kotlin + Compose SMS listener — forwards payment SMS to the API
├── scripts/            smoke-auth.sh + smoke-phase2.sh — end-to-end API verification
├── docker-compose.yml  postgres (5434) + minio (9000/9001, S3-compatible dev storage)
└── .env.example
```

## Documentation

Start with whichever question you actually have.

| Doc | Answers |
|---|---|
| [NEXT-SESSION.md](./NEXT-SESSION.md) | **Where the project is right now** — what shipped, what is left, what to know before touching anything. Start here. |
| [docs/SYSTEM.md](./docs/SYSTEM.md) | The complete technical reference: data layer, every backend module, the full API map, security in detail, the frontend. |
| [docs/FEATURES.md](./docs/FEATURES.md) | What each role actually gets, in product terms rather than code terms. |
| [docs/STUDIO.md](./docs/STUDIO.md) | Personalisation and theming — the two token layers, server-side colour derivation, the cosmetics economy. |
| [docs/UI-CONVENTIONS.md](./docs/UI-CONVENTIONS.md) | The rules the interface is held to: tokens, contrast floors, responsive widths, RTL, motion, stacking. Read before writing a screen. |
| [docs/GAMIFICATION.md](./docs/GAMIFICATION.md) | XP, coins, levels, achievements, missions, leaderboards — and why none of it can be farmed. |
| [docs/ARCHITECTURE-ACADEMY.md](./docs/ARCHITECTURE-ACADEMY.md) | Multi-tenant academy architecture: bounded contexts, tenant isolation, the ledger, the revenue model. |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Running it locally, deploying to Railway, environment variables, and proving a deploy actually shipped. |
| [docs/ACADEMY-COMPOSITION-PLAN.md](./docs/ACADEMY-COMPOSITION-PLAN.md) | The AI academy-site generator: the UI DSL, validation boundaries, quality gates. |
| [docs/PLAN-Platform-Parity.md](./docs/PLAN-Platform-Parity.md) | The roadmap, phased and prioritised. |
| [docs/REFERENCE-DrJosephAdel.md](./docs/REFERENCE-DrJosephAdel.md) · [docs/REFERENCE-EdNuva-TeacherFeatures.md](./docs/REFERENCE-EdNuva-TeacherFeatures.md) | Competitor teardowns the roadmap was drawn from. |
| [docs/android-payment-listener.md](./docs/android-payment-listener.md) · [docs/android-sms-listener.md](./docs/android-sms-listener.md) · [android/README.md](./android/README.md) | The Android app that turns a payment SMS into a verified enrolment. |
| [docs/email-setup.md](./docs/email-setup.md) | SMTP / Resend configuration. |

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
bash scripts/smoke-academy-ai.sh  # real AI generations: the model composes a
                                  # design system, and two runs differ (costs
                                  # a few cents per run — hits the live model)
bash scripts/smoke-all.sh         # every suite below, in sequence, with the
                                  # pauses the rate limiter needs — one summary
bash scripts/smoke-auth.sh        # 23 checks: auth, RBAC, session control
bash scripts/smoke-phase2.sh      # 37 checks: discovery, course CRUD, tenant
                                  # isolation, uploads, coupons, enrollments
bash scripts/smoke-phase3.sh      # 21 checks: encrypted-HLS transcode, signed
                                  # delivery, gated key, access control, anomaly
                                  # (needs ffmpeg + a sample video; see the script)
bash scripts/smoke-phase6.sh      # 20 checks: quiz author→take→auto+manual grade,
                                  # assignment submit→grade, reviews, certificates
bash scripts/smoke-device-sms.sh  # 25 checks: SMS-listener device OTP registration,
                                  # sender rules, event ingestion, idempotency,
                                  # token rotation + revocation (needs OTP_DEV_MODE)
bash scripts/smoke-payment-match.sh # 20 checks: student submits a transfer, the
                                  # listener posts the wallet SMS, payment auto-verifies
                                  # and the enrollment activates itself
npm run check:web                 # every internal link resolves to a route, and
                                  # ar/en translations are complete on both sides
```

`ffmpeg` and `ffprobe` must be on PATH for the video pipeline (`apt-get install ffmpeg`).

### Seeded dev accounts

| Role | Login | Credential |
|---|---|---|
| Super admin | `admin@darsly.app` | `Darsly@123` |
| Teachers ×6 | `teacher1@darsly.app` … `teacher6@darsly.app` | `Darsly@123` |
| Students ×N | `student1@darsly.app` … | `Darsly@123` |

**Everyone logs in with email + password.** Students self-register and are active
immediately; teachers register and land `PENDING` until a super admin approves them
(a pending teacher's login is rejected with `ACCOUNT_PENDING_APPROVAL`). Passwords are
argon2-hashed; login is rate-limited and soft-locks after repeated failures; a
hashed, single-use forgot/reset-password flow is included.

Seeded coupons: `WELCOME20` (khaled, 20% off) · `CHEM50` (noura, 50 EGP off the chem course).

Without SMTP configured, `OTP_DEV_MODE=true` makes `POST /api/v1/auth/forgot-password`
return the reset token in its response so the flow is testable in dev. **Never enable
in production.**

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
- **Design system:** a hand-tuned "ink & paper" system in
  `apps/web/tailwind.config.ts` — one accent (iris indigo `#4A32C9`), a warm
  neutral scale (paper `#F7F7F4` / ink `#1B1B22`, never pure black or white),
  a single 12px radius, and 1px hairlines instead of soft shadows. Rubik for
  headings, IBM Plex Sans Arabic for body — both Arabic-native. RTL-first, with
  sidebars on the right. **Every colour resolves through a CSS custom property**,
  which is what lets an academy's published palette and a student's theme
  repaint the app at runtime. See [docs/UI-CONVENTIONS.md](./docs/UI-CONVENTIONS.md)
  and [docs/STUDIO.md](./docs/STUDIO.md).

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
| 1 | Scaffolding, full DB schema, email+password auth (self-signup, teacher approval, lockout, forgot/reset), RBAC, sessions, seed, web shell | ✅ done & verified |
| 2 | Teacher/course/lesson CRUD (units, drip, free preview, pricing, coupons, uploads), student enrollment lifecycle (quote→request→approve/reject/revoke, auto-approve, subscriptions, bundles), discovery + public profiles, all React screens | ✅ done & verified |
| 3 | Encrypted-HLS pipeline (ffmpeg→AES-128), signed expiring URLs + per-session gated keys, DRM adapter (native + Widevine/PlayReady/FairPlay stubs), storage abstraction (local/S3), device + views-cap + time-window access control, multi-IP/rapid-seek anomaly flags, roving forensic watermark + hardened React player | ✅ done & verified |
| 4 | Chat (Socket.io), notifications, progress tracking, student comfort | ✅ done & verified |
| 5 | Double-entry ledger, wallet + invoices, payouts (teacher+admin), admin console (overview/approvals/payouts/security/audit), teacher security tab + Leak-Trace | ✅ done & verified |
| 6 | Quizzes (MCQ/true-false/short-answer, auto + manual grading), assignments (submit + grade), course reviews, completion certificates (serial + public verify + printable view) | ✅ done & verified |
| — | Live sessions + booking, teacher analytics, wishlist + badges, central soft-delete, route-level code-splitting | ✅ done & verified |
| — | Multi-tenant academies, AI academy-site studio, whitelabel branding, team & permissions | ✅ done & verified |
| — | Real card payments via XPay (a verified online payment lands on the same path a verified bank transfer does) | ✅ done & verified |
| — | Gamification engine: XP, coins, levels, achievements, missions, leaderboards, Learning Centre | ✅ done & verified |
| — | Student Studio: per-student theming on top of academy branding, server-derived colour, a cosmetics economy | ✅ done & verified |
| — | Chat rework: teacher-initiated, replies, voice notes, one thread per pair, per-side clearing, a teacher opt-out switch | ✅ done & verified |

Current state, and what is left, lives in [NEXT-SESSION.md](./NEXT-SESSION.md).

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
