-- Paying for a course out of a prepaid wallet balance. Additive and guarded, so
-- it is safe against a populated database and safe to re-run. The value is only
-- declared here, never used in this migration, which is what lets ADD VALUE run
-- inside the transaction Prisma wraps migrations in.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'WALLET';
