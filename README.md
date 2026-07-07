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
├── scripts/            smoke-auth.sh — end-to-end auth/RBAC verification
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
bash scripts/smoke-auth.sh        # 18 checks against the running API
```

### Seeded dev accounts

| Role | Login | Credential |
|---|---|---|
| Super admin | `admin@darsly.app` | `Admin@12345` |
| Teacher (math, 20% commission) | `khaled@darsly.app` | `Teacher@12345` |
| Teacher (chem, 15%, auto-approve) | `noura@darsly.app` | `Teacher@12345` |
| Students ×5 | `+201011111111` … `+201055555555` | OTP — dev universal code `0000` |

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
| 2 | Teacher/course/lesson CRUD, student enrollment, discovery | ⏳ next |
| 3 | Secure video pipeline (ffmpeg→AES-HLS), watermarked hardened player, session/device control | |
| 4 | Chat (Socket.io), notifications, progress tracking, student comfort | |
| 5 | Payments ledger, payouts, admin dashboards, teacher security tab | |
| 6 | Quizzes, reviews, certificates, tests, polish | |

## API docs

Swagger UI at `http://localhost:4000/api/docs` (OpenAPI 3), grouped by tag
(`auth`, `catalog`, `health`; grows each phase).

## Dev notes

- Darsly Postgres runs on **5434** (5432/5433 were taken on the dev machine).
- Vite watches via polling by default here (Linux inotify-instance exhaustion);
  set `VITE_NO_POLLING=1` for native watchers, or raise
  `fs.inotify.max_user_instances` (needs sudo) and use native watching.
