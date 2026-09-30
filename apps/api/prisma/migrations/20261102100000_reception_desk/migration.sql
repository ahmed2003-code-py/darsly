-- Center Operations C3 — QR student cards and the reception desk.
--
-- Additive only: a new enum, two new AttendanceMethod values, one new table.
-- No existing row is read or written, no card is issued to anyone, and no
-- attendance changes. (Prisma's diff also proposes dropping
-- AcademyStudent_nameNormalized_trgm_idx: that index is C1's, created by hand
-- in its migration because the schema language cannot express it — kept.)

-- CreateEnum
CREATE TYPE "CardRevokeReason" AS ENUM ('LOST', 'DAMAGED', 'SECURITY', 'REISSUED', 'MANUAL', 'OTHER');

-- AlterEnum (the new values are not used anywhere in this migration)
ALTER TYPE "AttendanceMethod" ADD VALUE 'QR';
ALTER TYPE "AttendanceMethod" ADD VALUE 'CODE';

-- CreateTable
CREATE TABLE "AcademyStudentCard" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokeReason" "CardRevokeReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyStudentCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcademyStudentCard_tokenHash_key" ON "AcademyStudentCard"("tokenHash");

-- CreateIndex
CREATE INDEX "AcademyStudentCard_academyStudentId_issuedAt_idx" ON "AcademyStudentCard"("academyStudentId", "issuedAt");

-- CreateIndex
CREATE INDEX "AcademyStudentCard_academyId_idx" ON "AcademyStudentCard"("academyId");

-- AddForeignKey
ALTER TABLE "AcademyStudentCard" ADD CONSTRAINT "AcademyStudentCard_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyStudentCard" ADD CONSTRAINT "AcademyStudentCard_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── What the database itself guarantees ─────────────────────────────────

-- At most one working card per learner. Two desks issuing at once, or a
-- reissue racing another, cannot leave two cards that both scan.
CREATE UNIQUE INDEX "AcademyStudentCard_one_active_key"
  ON "AcademyStudentCard"("academyStudentId") WHERE "revokedAt" IS NULL;

-- Only a SHA-256 digest is ever stored: 64 lowercase hex characters. The
-- token itself is 48 decimal digits, so a code path that wrote the raw token
-- (or anything but a digest) fails here instead of quietly keeping a
-- reproducible card in the database.
ALTER TABLE "AcademyStudentCard" ADD CONSTRAINT "AcademyStudentCard_hash_only"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- A revocation is whole: when, by whom and why — all three or none.
ALTER TABLE "AcademyStudentCard" ADD CONSTRAINT "AcademyStudentCard_revocation_whole"
  CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL)
     AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL));

-- A card belongs to its learner's academy; it never changes identity, and a
-- revoked card never works again (a new card is a new row).
CREATE FUNCTION desk_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AcademyStudent" s
    WHERE s.id = NEW."academyStudentId" AND s."academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'AcademyStudentCard % crosses academies', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tokenHash" <> OLD."tokenHash" OR NEW."academyId" <> OLD."academyId"
       OR NEW."academyStudentId" <> OLD."academyStudentId" OR NEW."issuedAt" <> OLD."issuedAt"
       OR NEW."issuedBy" <> OLD."issuedBy" THEN
      RAISE EXCEPTION 'AcademyStudentCard % cannot change identity', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
       OR NEW."revokedBy" IS DISTINCT FROM OLD."revokedBy"
       OR NEW."revokeReason" IS DISTINCT FROM OLD."revokeReason") THEN
      RAISE EXCEPTION 'AcademyStudentCard % is revoked for good', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AcademyStudentCard_guard"
  BEFORE INSERT OR UPDATE ON "AcademyStudentCard"
  FOR EACH ROW EXECUTE FUNCTION desk_card_guard();
