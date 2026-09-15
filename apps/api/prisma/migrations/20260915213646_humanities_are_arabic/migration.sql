-- History, geography, philosophy and psychology are taught in Arabic in both
-- school systems. A language school does not have a "History" in English; it
-- has التاريخ, the same as everyone else. The catalogue had two rows for each,
-- which put a subject nobody teaches in front of every languages-track
-- teacher and student.
--
-- So the Arabic row becomes BOTH — visible to either track — and the English
-- row is retired. Retired, not deleted, and only after anything pointing at it
-- has been moved to the Arabic row: a teacher who picked "هيستوري" keeps
-- teaching history, a course keeps its subject, an interest keeps its subject.
-- `ON CONFLICT DO NOTHING` covers the teacher or student who had already
-- picked both rows and would otherwise collide on the join table's key.

-- ── Move every reference from the English row to the Arabic one ─────────────
INSERT INTO "TeacherSubject" ("tenantId", "subjectId")
SELECT ts."tenantId", g.id
FROM "TeacherSubject" ts
JOIN "Subject" l ON l.id = ts."subjectId"
JOIN "Subject" g ON g.code = regexp_replace(l.code, '-lang$', '-gen')
WHERE l.code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang')
ON CONFLICT DO NOTHING;

DELETE FROM "TeacherSubject" ts
USING "Subject" l
WHERE l.id = ts."subjectId"
  AND l.code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang');

INSERT INTO "StudentInterest" ("studentId", "subjectId")
SELECT si."studentId", g.id
FROM "StudentInterest" si
JOIN "Subject" l ON l.id = si."subjectId"
JOIN "Subject" g ON g.code = regexp_replace(l.code, '-lang$', '-gen')
WHERE l.code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang')
ON CONFLICT DO NOTHING;

DELETE FROM "StudentInterest" si
USING "Subject" l
WHERE l.id = si."subjectId"
  AND l.code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang');

UPDATE "Course" c
SET "subjectId" = g.id
FROM "Subject" l
JOIN "Subject" g ON g.code = regexp_replace(l.code, '-lang$', '-gen')
WHERE c."subjectId" = l.id
  AND l.code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang');

-- ── One row each, for everyone ──────────────────────────────────────────────
UPDATE "Subject"
SET "track" = 'BOTH'
WHERE code IN ('history-gen', 'geography-gen', 'philosophy-gen', 'psych-gen');

UPDATE "Subject"
SET "isActive" = false
WHERE code IN ('history-lang', 'geography-lang', 'philosophy-lang', 'psych-lang');
