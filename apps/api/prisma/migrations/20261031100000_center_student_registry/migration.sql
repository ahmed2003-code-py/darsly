-- Center Operations C1 — Student Registry.
--
-- Additive only: two new tables, one nullable column on StudentProfile, SQL
-- functions, three triggers, and a backfill that only INSERTs into the new
-- table. No existing row is updated or deleted, so the running (previous)
-- API keeps working against this schema.
--
--   AcademyStudent   the academy's own record of a learner (code, contacts,
--                    school, year, ACTIVE/WITHDRAWN). Points at the canonical
--                    StudentProfile; never a second identity.
--   StudentImport    a validated spreadsheet batch, committed idempotently.
--
-- Names are normalised in ONE place: academy_student_name_key() below. The
-- API never writes AcademyStudent.nameNormalized; a trigger derives it from
-- fullName on every write, and search normalises its input with the same
-- function.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "AcademyStudentStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AcademyStudentSource" AS ENUM ('DESK', 'IMPORT', 'ONLINE', 'BACKFILL');

-- CreateEnum
CREATE TYPE "StudentImportStatus" AS ENUM ('PREVIEWED', 'COMMITTING', 'COMMITTED');

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "provisionedByAcademyId" TEXT;

-- CreateTable
CREATE TABLE "AcademyStudent" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL DEFAULT '',
    "studentPhone" TEXT,
    "guardianName" TEXT,
    "guardianPhone" TEXT,
    "school" TEXT,
    "gradeId" TEXT,
    "status" "AcademyStudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "AcademyStudentSource" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademyStudent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentImport" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "status" "StudentImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "contentHash" TEXT NOT NULL,
    "fileName" TEXT,
    "rows" JSONB,
    "results" JSONB,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademyStudent_academyId_status_nameNormalized_idx" ON "AcademyStudent"("academyId", "status", "nameNormalized");

-- CreateIndex
CREATE INDEX "AcademyStudent_academyId_studentPhone_idx" ON "AcademyStudent"("academyId", "studentPhone");

-- CreateIndex
CREATE INDEX "AcademyStudent_academyId_guardianPhone_idx" ON "AcademyStudent"("academyId", "guardianPhone");

-- CreateIndex
CREATE INDEX "AcademyStudent_studentId_idx" ON "AcademyStudent"("studentId");

-- CreateIndex
CREATE INDEX "AcademyStudent_gradeId_idx" ON "AcademyStudent"("gradeId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyStudent_academyId_studentId_key" ON "AcademyStudent"("academyId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyStudent_academyId_code_key" ON "AcademyStudent"("academyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyStudent_academyId_requestKey_key" ON "AcademyStudent"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "StudentImport_academyId_createdAt_idx" ON "StudentImport"("academyId", "createdAt");

-- CreateIndex
CREATE INDEX "StudentImport_academyId_contentHash_idx" ON "StudentImport"("academyId", "contentHash");

-- AddForeignKey
ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "GradeLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentImport" ADD CONSTRAINT "StudentImport_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentProfile" ADD CONSTRAINT "StudentProfile_provisionedByAcademyId_fkey" FOREIGN KEY ("provisionedByAcademyId") REFERENCES "Academy"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Arabic-aware search key ──────────────────────────────────────────────────
-- lower-case; strip harakat, superscript alef, tatweel, Quranic marks and
-- invisible direction/zero-width marks; fold alef/hamza forms (أ إ آ ٱ → ا),
-- ى/ی → ي, ة → ه, ؤ → و, ئ → ي, ک → ك; Arabic-Indic and Persian digits → 0-9;
-- "عبد الله" and "عبدالله" alike; collapse every run of whitespace (NBSP too).
CREATE FUNCTION academy_student_name_key(t text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(
        regexp_replace(lower(t), '[\u064B-\u065F\u0670\u0640\u06D6-\u06ED\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]', '', 'g'),
        'أإآٱىیةؤئک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
        'ااااييهويك01234567890123456789'),
      '(^|[\s\u00A0])عبد[\s\u00A0]+', '\1عبد', 'g'),
    '[\s\u00A0]+', ' ', 'g'))
$$;

-- The key is derived, never supplied: whatever a client (or a bug) writes into
-- nameNormalized is replaced on every insert and update.
CREATE FUNCTION academy_student_set_name_key() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."nameNormalized" := academy_student_name_key(NEW."fullName");
  RETURN NEW;
END $$;

CREATE TRIGGER "AcademyStudent_name_key"
  BEFORE INSERT OR UPDATE ON "AcademyStudent"
  FOR EACH ROW EXECUTE FUNCTION academy_student_set_name_key();

-- Name search: substring (LIKE '%…%') over the normalised key.
CREATE INDEX "AcademyStudent_nameNormalized_trgm_idx"
  ON "AcademyStudent" USING gin ("nameNormalized" gin_trgm_ops);

-- ── Student codes ────────────────────────────────────────────────────────────
-- Six digits, first never 0, last a Luhn check digit over the first five. The
-- API generates codes (center-students/student-code.ts); the SQL generator
-- below is used only by this migration's backfill and the Enrollment trigger.
-- The CHECK is the single definition of a valid code, whoever made it.
CREATE FUNCTION academy_student_code_ok(c text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  s int := 0; d int; i int; dbl boolean := false;
BEGIN
  IF c !~ '^[1-9][0-9]{5}$' THEN RETURN false; END IF;
  FOR i IN REVERSE 6..1 LOOP
    d := substr(c, i, 1)::int;
    IF dbl THEN d := d * 2; IF d > 9 THEN d := d - 9; END IF; END IF;
    s := s + d;
    dbl := NOT dbl;
  END LOOP;
  RETURN s % 10 = 0;
END $$;

CREATE FUNCTION academy_student_new_code() RETURNS text
  LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  body text := (10000 + floor(random() * 90000))::int::text;
  s int := 0; d int; i int; dbl boolean := true;
BEGIN
  FOR i IN REVERSE 5..1 LOOP
    d := substr(body, i, 1)::int;
    IF dbl THEN d := d * 2; IF d > 9 THEN d := d - 9; END IF; END IF;
    s := s + d;
    dbl := NOT dbl;
  END LOOP;
  RETURN body || ((10 - s % 10) % 10)::text;
END $$;

ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_code_check"
  CHECK (academy_student_code_ok("code"));

-- Phones are stored exactly as normalizeEgyptianPhone() writes them.
ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_phones_check" CHECK (
  ("studentPhone" IS NULL OR "studentPhone" ~ '^\+201[0125][0-9]{8}$')
  AND ("guardianPhone" IS NULL OR "guardianPhone" ~ '^\+201[0125][0-9]{8}$')
);

-- WITHDRAWN always says since when; ACTIVE never does.
ALTER TABLE "AcademyStudent" ADD CONSTRAINT "AcademyStudent_left_check" CHECK (
  ("status" = 'WITHDRAWN') = ("leftAt" IS NOT NULL)
);

-- One register row for (academy, learner), with a fresh code, retried on the
-- (rare) code collision. Returns true when a row exists afterwards. Never
-- raises for a collision: ON CONFLICT DO NOTHING absorbs both the pair and the
-- code conflict, and the pair check below tells them apart.
CREATE FUNCTION academy_student_ensure(
  p_academy text, p_student text, p_source "AcademyStudentSource", p_joined timestamp
) RETURNS boolean
  LANGUAGE plpgsql AS $$
DECLARE
  who record; i int;
BEGIN
  IF EXISTS (SELECT 1 FROM "AcademyStudent" WHERE "academyId" = p_academy AND "studentId" = p_student) THEN
    RETURN true;
  END IF;
  SELECT u."fullName", sp."gradeId" INTO who
    FROM "StudentProfile" sp JOIN "User" u ON u.id = sp."userId"
   WHERE sp.id = p_student;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR i IN 1..20 LOOP
    INSERT INTO "AcademyStudent" ("id", "academyId", "studentId", "code", "fullName", "gradeId",
                                  "status", "source", "joinedAt", "createdAt", "updatedAt")
    VALUES ('c' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
            p_academy, p_student, academy_student_new_code(), who."fullName", who."gradeId",
            'ACTIVE', p_source, p_joined, now(), now())
    ON CONFLICT DO NOTHING;
    IF EXISTS (SELECT 1 FROM "AcademyStudent" WHERE "academyId" = p_academy AND "studentId" = p_student) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;

-- ── Online enrollments join the register ─────────────────────────────────────
-- Every learner enrolled in an academy's course is that academy's student, so
-- the register stays complete however the enrollment was made (checkout,
-- wallet, cash, free, demo, approval). It must never cost an enrollment: any
-- failure here is logged as a WARNING and the enrollment goes ahead; the API
-- re-ensures the row where it needs it (GroupsService.addMembers).
CREATE FUNCTION academy_student_from_enrollment() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."academyId" IS NULL OR NEW."deletedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF NOT academy_student_ensure(NEW."academyId", NEW."studentId", 'ONLINE', now()::timestamp) THEN
      RAISE WARNING 'academy_student_from_enrollment: no register row for enrollment %', NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'academy_student_from_enrollment: % (enrollment %)', SQLERRM, NEW.id;
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER "Enrollment_academy_student"
  AFTER INSERT OR UPDATE OF "academyId", "deletedAt" ON "Enrollment"
  FOR EACH ROW EXECUTE FUNCTION academy_student_from_enrollment();

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Every (academy, learner) the academy already had: an enrollment in one of
-- its courses, a membership in one of its groups, or an active guardian link
-- it issued. Live rows only (no soft-deleted academy, profile, user or source
-- row). Idempotent: an existing pair is left exactly as it is.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH pairs AS (
      SELECT "academyId", "studentId", min("createdAt") AS since
        FROM "Enrollment" WHERE "deletedAt" IS NULL AND "academyId" IS NOT NULL GROUP BY 1, 2
      UNION ALL
      SELECT "academyId", "studentId", min("addedAt")
        FROM "GroupMembership" WHERE "deletedAt" IS NULL GROUP BY 1, 2
      UNION ALL
      SELECT "academyId", "studentId", min("createdAt")
        FROM "GuardianLink" WHERE "status" = 'ACTIVE' GROUP BY 1, 2
    )
    SELECT p."academyId", p."studentId", min(p.since) AS since
      FROM pairs p
      JOIN "Academy" a ON a.id = p."academyId" AND a."deletedAt" IS NULL
      JOIN "StudentProfile" sp ON sp.id = p."studentId" AND sp."deletedAt" IS NULL
      JOIN "User" u ON u.id = sp."userId" AND u."deletedAt" IS NULL
     GROUP BY p."academyId", p."studentId"
     ORDER BY p."academyId", min(p.since)
  LOOP
    IF NOT academy_student_ensure(r."academyId", r."studentId", 'BACKFILL', r.since) THEN
      RAISE EXCEPTION 'student registry backfill: could not register % in %', r."studentId", r."academyId";
    END IF;
  END LOOP;
END $$;
