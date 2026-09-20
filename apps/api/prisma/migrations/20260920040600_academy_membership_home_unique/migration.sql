-- Enforces "one isHome=true AcademyMembership per user" at the database level.
-- Previously enforced only in application code (provision.ts / backfill). A prior
-- audit confirmed zero violations in production data before this migration was written.
--
-- This is a partial unique index (Prisma's schema DSL has no syntax for WHERE-qualified
-- unique constraints), so it is not represented in schema.prisma — it is applied and
-- tracked purely through this migration file, same as any other index Prisma can't model.
CREATE UNIQUE INDEX "AcademyMembership_userId_home_unique"
  ON "AcademyMembership" ("userId")
  WHERE "isHome" = true AND "deletedAt" IS NULL;
