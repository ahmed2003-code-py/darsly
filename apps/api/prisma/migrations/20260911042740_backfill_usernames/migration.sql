-- Every account that predates usernames gets one made from the front of its
-- email, the same way registration derives it now: lowercase, non [a-z0-9_]
-- runs collapsed to "_", must start with a letter, clashes numbered by age.
--
-- This runs at boot and a failed migration blocks the deploy, so it is built
-- to be unable to violate the unique index: after suffixing, any name still
-- shared by two rows gets a per-row hash, and any row whose name is *still*
-- not unique in the batch is simply left for later rather than risked. Such a
-- person can still sign in by email or phone.
UPDATE "User" u
SET "username" = f.uname
FROM (
  SELECT id, uname
  FROM (
    SELECT id, uname, count(*) OVER (PARTITION BY uname) AS n
    FROM (
      SELECT id,
             CASE WHEN rn2 = 1 THEN uname1 ELSE uname1 || '_' || left(md5(id), 6) END AS uname
      FROM (
        SELECT id, uname1, row_number() OVER (PARTITION BY uname1 ORDER BY "createdAt", id) AS rn2
        FROM (
          SELECT id, "createdAt",
                 CASE WHEN rn = 1 THEN base ELSE base || '_' || (rn - 1) END AS uname1
          FROM (
            SELECT id, "createdAt", base,
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
        ) q
      ) p
    ) o
  ) m
  WHERE n = 1
) f
WHERE u.id = f.id
  AND NOT EXISTS (SELECT 1 FROM "User" x WHERE x.username = f.uname);
