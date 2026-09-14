-- Two school systems, one catalogue.
--
-- A language school's "Math" and the national system's "الرياضيات" are not the
-- same course, so they are separate subjects, and a student sees only the ones
-- their own school actually teaches. The subjects everybody sits whichever
-- school they are in — Arabic, religion, social studies, second languages —
-- are marked BOTH and stay in one row.
--
-- Everything here is written to survive a non-empty production table: the new
-- columns have defaults, the catalogue is keyed on `code` so running it again
-- updates the rows teachers and courses already point at rather than
-- duplicating them, and the teacher's single subject is copied into the new
-- join table before the column it lived in goes away.

-- ── The enum ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SubjectTrack" AS ENUM ('GENERAL', 'LANGUAGES', 'BOTH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Subject: a stable key and the system it belongs to ──────────────────────
ALTER TABLE "Subject" ADD COLUMN IF NOT EXISTS "code" TEXT;
ALTER TABLE "Subject" ADD COLUMN IF NOT EXISTS "track" "SubjectTrack" NOT NULL DEFAULT 'BOTH';

-- Adopt whatever is already there. Matching on the Arabic name keeps the ids
-- the existing teachers, courses and interests point at, so the upsert below
-- updates those rows instead of creating a second "الرياضيات" beside them.
UPDATE "Subject" SET "code" = 'math-gen'    WHERE "code" IS NULL AND "nameAr" = 'الرياضيات';
UPDATE "Subject" SET "code" = 'physics-gen' WHERE "code" IS NULL AND "nameAr" = 'الفيزياء';
UPDATE "Subject" SET "code" = 'chem-gen'    WHERE "code" IS NULL AND "nameAr" = 'الكيمياء';
UPDATE "Subject" SET "code" = 'bio-gen'     WHERE "code" IS NULL AND "nameAr" = 'الأحياء';
UPDATE "Subject" SET "code" = 'science-gen' WHERE "code" IS NULL AND "nameAr" = 'العلوم';
UPDATE "Subject" SET "code" = 'arabic'      WHERE "code" IS NULL AND "nameAr" = 'اللغة العربية';
UPDATE "Subject" SET "code" = 'english'     WHERE "code" IS NULL AND "nameAr" = 'اللغة الإنجليزية';

-- Anything else an admin added by hand keeps its own key and stays visible to
-- everyone (track already defaults to BOTH).
UPDATE "Subject" SET "code" = 'legacy-' || "id" WHERE "code" IS NULL;

-- Left nullable: the key exists so the platform's own catalogue can be seeded
-- again without duplicating itself, and a subject an admin adds by hand through
-- the console has nothing to key. Postgres allows many NULLs under a unique
-- index, so those rows coexist and the seeded ones stay unique.
CREATE UNIQUE INDEX IF NOT EXISTS "Subject_code_key" ON "Subject"("code");

-- ── The catalogue ───────────────────────────────────────────────────────────
-- Ordered so the picker reads in groups: shared first (everyone needs them),
-- then the national system, then the language schools.
INSERT INTO "Subject" ("id", "code", "nameAr", "nameEn", "icon", "sortOrder", "isActive", "track")
VALUES
  -- Shared — sat by every student, whichever school they are in.
  (gen_random_uuid()::text, 'arabic',         'اللغة العربية',         'Arabic',                'menu_book',    0,  true, 'BOTH'),
  (gen_random_uuid()::text, 'religion',       'التربية الدينية',       'Religious Education',   'mosque',       1,  true, 'BOTH'),
  (gen_random_uuid()::text, 'social',         'الدراسات الاجتماعية',   'Social Studies',        'public',       2,  true, 'BOTH'),
  (gen_random_uuid()::text, 'english',        'اللغة الإنجليزية',      'English',               'translate',    3,  true, 'BOTH'),
  (gen_random_uuid()::text, 'french',         'اللغة الفرنسية',        'French',                'translate',    4,  true, 'BOTH'),
  (gen_random_uuid()::text, 'german',         'اللغة الألمانية',       'German',                'translate',    5,  true, 'BOTH'),
  (gen_random_uuid()::text, 'italian',        'اللغة الإيطالية',       'Italian',               'translate',    6,  true, 'BOTH'),
  (gen_random_uuid()::text, 'programming',    'البرمجة',               'Programming',           'code',         7,  true, 'BOTH'),

  -- National system — taught in Arabic.
  (gen_random_uuid()::text, 'math-gen',       'الرياضيات',             'Mathematics',           'calculate',    20, true, 'GENERAL'),
  (gen_random_uuid()::text, 'algebra-gen',    'الجبر وحساب المثلثات',  'Algebra & Trigonometry','functions',    21, true, 'GENERAL'),
  (gen_random_uuid()::text, 'calculus-gen',   'التفاضل والتكامل',      'Calculus',              'show_chart',   22, true, 'GENERAL'),
  (gen_random_uuid()::text, 'statics-gen',    'الاستاتيكا',            'Statics',               'architecture', 23, true, 'GENERAL'),
  (gen_random_uuid()::text, 'dynamics-gen',   'الديناميكا',            'Dynamics',              'speed',        24, true, 'GENERAL'),
  (gen_random_uuid()::text, 'science-gen',    'العلوم',                'Science',               'science',      25, true, 'GENERAL'),
  (gen_random_uuid()::text, 'physics-gen',    'الفيزياء',              'Physics',               'bolt',         26, true, 'GENERAL'),
  (gen_random_uuid()::text, 'chem-gen',       'الكيمياء',              'Chemistry',             'experiment',   27, true, 'GENERAL'),
  (gen_random_uuid()::text, 'bio-gen',        'الأحياء',               'Biology',               'biotech',      28, true, 'GENERAL'),
  (gen_random_uuid()::text, 'geology-gen',    'الجيولوجيا',            'Geology',               'landscape',    29, true, 'GENERAL'),
  (gen_random_uuid()::text, 'history-gen',    'التاريخ',               'History',               'history_edu',  30, true, 'GENERAL'),
  (gen_random_uuid()::text, 'geography-gen',  'الجغرافيا',             'Geography',             'map',          31, true, 'GENERAL'),
  (gen_random_uuid()::text, 'philosophy-gen', 'الفلسفة والمنطق',       'Philosophy & Logic',    'psychology_alt',32,true, 'GENERAL'),
  (gen_random_uuid()::text, 'psych-gen',      'علم النفس والاجتماع',   'Psychology & Sociology','diversity_3',  33, true, 'GENERAL'),
  (gen_random_uuid()::text, 'econ-gen',       'الاقتصاد والإحصاء',     'Economics & Statistics','trending_up',  34, true, 'GENERAL'),
  (gen_random_uuid()::text, 'computer-gen',   'الحاسب الآلي',          'Computer Science',      'computer',     35, true, 'GENERAL'),

  -- Language schools — taught in English. Named the way students say them.
  (gen_random_uuid()::text, 'math-lang',      'ماث',                   'Math',                  'calculate',    50, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'science-lang',   'ساينس',                 'Science',               'science',      51, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'physics-lang',   'فيزيكس',                'Physics',               'bolt',         52, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'chem-lang',      'كيميستري',              'Chemistry',             'experiment',   53, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'bio-lang',       'بيولوجي',               'Biology',               'biotech',      54, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'geology-lang',   'جيولوجي',               'Geology',               'landscape',    55, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'history-lang',   'هيستوري',               'History',               'history_edu',  56, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'geography-lang', 'جيوجرافي',              'Geography',             'map',          57, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'philosophy-lang','فيلوسوفي',              'Philosophy',            'psychology_alt',58,true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'psych-lang',     'سايكولوجي',             'Psychology',            'diversity_3',  59, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'econ-lang',      'إيكونوميكس',            'Economics',             'trending_up',  60, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'compsci-lang',   'كمبيوتر ساينس',         'Computer Science',      'computer',     61, true, 'LANGUAGES'),
  (gen_random_uuid()::text, 'ict-lang',       'آي سي تي',              'ICT',                   'devices',      62, true, 'LANGUAGES')
ON CONFLICT ("code") DO UPDATE
  SET "nameAr"    = EXCLUDED."nameAr",
      "nameEn"    = EXCLUDED."nameEn",
      "icon"      = EXCLUDED."icon",
      "sortOrder" = EXCLUDED."sortOrder",
      "track"     = EXCLUDED."track",
      "isActive"  = true;

-- ── The student's school system ─────────────────────────────────────────────
-- Nullable on purpose: everyone who signed up before this question existed
-- keeps seeing the whole catalogue until they answer it.
ALTER TABLE "StudentProfile" ADD COLUMN IF NOT EXISTS "track" "SubjectTrack";

-- ── What a teacher teaches, as a set ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TeacherSubject" (
  "tenantId"  TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  CONSTRAINT "TeacherSubject_pkey" PRIMARY KEY ("tenantId", "subjectId")
);

CREATE INDEX IF NOT EXISTS "TeacherSubject_subjectId_idx" ON "TeacherSubject"("subjectId");

DO $$ BEGIN
  ALTER TABLE "TeacherSubject"
    ADD CONSTRAINT "TeacherSubject_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "TeacherProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TeacherSubject"
    ADD CONSTRAINT "TeacherSubject_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Carry every teacher's existing subject across before the column goes. A
-- teacher whose subject was never set simply arrives with an empty set, which
-- is the same thing it meant before.
INSERT INTO "TeacherSubject" ("tenantId", "subjectId")
SELECT "id", "subjectId" FROM "TeacherProfile" WHERE "subjectId" IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE "TeacherProfile" DROP COLUMN IF EXISTS "subjectId";
