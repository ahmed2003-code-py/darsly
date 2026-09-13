-- Which teacher's look a student chose to wear. Additive and nullable: a
-- student who has never chosen keeps the old behaviour exactly, which is the
-- academy they enrolled with first.
ALTER TABLE "StudentCustomization" ADD COLUMN IF NOT EXISTS "academyId" TEXT;
