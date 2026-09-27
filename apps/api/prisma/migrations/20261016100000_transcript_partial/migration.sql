-- Additive: a usable transcript with pieces missing. Its own migration, so the
-- new value is committed before anything could use it.
ALTER TYPE "LivePipelineStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
