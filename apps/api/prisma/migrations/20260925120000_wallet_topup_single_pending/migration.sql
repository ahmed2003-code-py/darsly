-- One pending top-up per student, enforced by the database.
--
-- The application asked "is one already under review?" with a SELECT and then
-- INSERTed. Two submits a few milliseconds apart both pass that read and both
-- insert. It is not a cosmetic duplicate: each top-up carries a transfer
-- receipt an admin approves, and approving two receipts for one transfer
-- credits the wallet twice.
--
-- The index is partial on two conditions, and both matter:
--
--   status = 'PENDING'   — a student may have any number of APPROVED or
--                          REJECTED top-ups in their history; what they may
--                          not have is two awaiting a decision.
--
--   deletedAt IS NULL    — WalletTopup is soft-deleted, and every application
--                          read is filtered by the Prisma middleware. Without
--                          this clause a soft-deleted pending row would block
--                          a new top-up that the application cannot even see,
--                          and the student would be refused for a reason
--                          nobody could explain.
--
-- Duplicates already in the table would make the index fail to build, so the
-- older of each pair is rejected first. Expected to match nothing.
UPDATE "WalletTopup" t
SET "status" = 'REJECTED',
    "rejectedReason" = COALESCE(t."rejectedReason", 'Superseded by a newer pending top-up; only one may be under review at a time.')
WHERE t."status" = 'PENDING'
  AND t."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "WalletTopup" n
    WHERE n."studentId" = t."studentId"
      AND n."status" = 'PENDING'
      AND n."deletedAt" IS NULL
      AND (n."createdAt" > t."createdAt" OR (n."createdAt" = t."createdAt" AND n."id" > t."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "WalletTopup_one_pending_per_student_key"
  ON "WalletTopup"("studentId")
  WHERE "status" = 'PENDING' AND "deletedAt" IS NULL;
