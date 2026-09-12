-- Every year a student can be sitting in, so the stage a teacher signed up for
-- always has students who can pick it. Existing rows keep their ids: courses
-- and profiles already point at them.
INSERT INTO "GradeLevel" ("id", "nameAr", "nameEn", "code", "sortOrder", "isActive", "stage")
VALUES
  (gen_random_uuid()::text, 'الأول الابتدائي',  'Primary 1',       'prim-1',  0,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'الثاني الابتدائي', 'Primary 2',       'prim-2',  1,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'الثالث الابتدائي', 'Primary 3',       'prim-3',  2,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'الرابع الابتدائي', 'Primary 4',       'prim-4',  3,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'الخامس الابتدائي', 'Primary 5',       'prim-5',  4,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'السادس الابتدائي', 'Primary 6',       'prim-6',  5,  true, 'PRIMARY'),
  (gen_random_uuid()::text, 'الأول الإعدادي',   'Prep 1',          'prep-1',  10, true, 'PREPARATORY'),
  (gen_random_uuid()::text, 'الثاني الإعدادي',  'Prep 2',          'prep-2',  11, true, 'PREPARATORY'),
  (gen_random_uuid()::text, 'الثالث الإعدادي',  'Prep 3',          'prep-3',  12, true, 'PREPARATORY'),
  (gen_random_uuid()::text, 'الأول الثانوي',    'Secondary 1',     'sec-1',   20, true, 'SECONDARY'),
  (gen_random_uuid()::text, 'الثاني الثانوي',   'Secondary 2',     'sec-2',   21, true, 'SECONDARY'),
  (gen_random_uuid()::text, 'الثالث الثانوي',   'Secondary 3',     'sec-3',   22, true, 'SECONDARY'),
  (gen_random_uuid()::text, 'الأول بكالوريا',   'Baccalaureate 1', 'bacc-1',  30, true, 'BACCALAUREATE'),
  (gen_random_uuid()::text, 'الثاني بكالوريا',  'Baccalaureate 2', 'bacc-2',  31, true, 'BACCALAUREATE'),
  (gen_random_uuid()::text, 'الثالث بكالوريا',  'Baccalaureate 3', 'bacc-3',  32, true, 'BACCALAUREATE')
ON CONFLICT ("code") DO UPDATE
  SET "sortOrder" = EXCLUDED."sortOrder",
      "stage"     = EXCLUDED."stage",
      "isActive"  = true;
