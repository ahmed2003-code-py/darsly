-- Every account that predates usernames gets one made from the front of its
-- email, the same way registration derives it now: lowercase, non [a-z0-9_]
-- runs collapsed to "_", must start with a letter, clashes numbered by age.
UPDATE "User" u
SET "username" = d.uname
FROM (
  SELECT id,
         CASE WHEN rn = 1 THEN base ELSE base || '_' || (rn - 1) END AS uname
  FROM (
    SELECT id,
           base,
           row_number() OVER (PARTITION BY base ORDER BY "createdAt", id) AS rn
    FROM (
      SELECT id, "createdAt",
             CASE WHEN b ~ '^[a-z]' THEN b ELSE 'u_' || b END AS base
      FROM (
        SELECT id, "createdAt",
               left(regexp_replace(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9_]+', '_', 'g'), '^_+|_+$', '', 'g'), 28) AS b
        FROM "User"
        WHERE email IS NOT NULL AND username IS NULL
      ) s
    ) t
  ) r
) d
WHERE u.id = d.id
  AND NOT EXISTS (SELECT 1 FROM "User" x WHERE x.username = d.uname);
