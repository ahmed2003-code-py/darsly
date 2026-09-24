-- One import's cost and timeline, read-only.
--
-- Two ways to use this file. Neither needs a credential pasted anywhere.
--
-- (B) is enough on its own: run its SELECTs in Railway → Postgres service →
--     Data → Query, and share the result rows. Nothing here writes.
-- (A) is for running scripts/ocr-bench/prod-run-report.ts: a login role that
--     can SELECT exactly the columns the report reads and nothing else.
--     Run it once, as the database owner, only if you choose that route.

-- ════════════════════════════════════════════════════════════════════════
-- (A) A dedicated read-only role — review before running; nothing runs it
--     automatically. Replace the password with a generated one and keep it
--     in Railway variables, never in the repository or in chat.
-- ════════════════════════════════════════════════════════════════════════
-- CREATE ROLE darsly_audit LOGIN PASSWORD '<generate-a-long-random-password>'
--   CONNECTION LIMIT 2;
-- ALTER ROLE darsly_audit SET default_transaction_read_only = on;
-- ALTER ROLE darsly_audit SET statement_timeout = '30s';
-- GRANT CONNECT ON DATABASE railway TO darsly_audit;
-- GRANT USAGE ON SCHEMA public TO darsly_audit;
--
-- -- Exactly the columns the report selects. No exam text (draft, warnings,
-- -- extracted), no teacher/academy/student identifiers, no other tables.
-- GRANT SELECT (id, kind, status, stage, "createdAt", "updatedAt", "durationMs",
--   "costCents", "inputTokens", "outputTokens", "escalatedPages", "highAccuracy")
--   ON "PaperImport" TO darsly_audit;
-- GRANT SELECT (id, status, attempts, stage, "createdAt", "updatedAt", "costCents",
--   "errorClass", input)          -- input = {importId, phase, tier}; used to find the job
--   ON "AiJob" TO darsly_audit;
-- GRANT SELECT ("importId", stage, region, attempt, model, "reasoningEffort",
--   "imageCount", "startedAt", "latencyMs", status, error, "responseId",
--   "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens",
--   "costMillicents", meta)
--   ON "AiCallLog" TO darsly_audit;
--
-- -- To remove it afterwards:
-- -- REVOKE ALL ON "PaperImport", "AiJob", "AiCallLog" FROM darsly_audit;
-- -- REVOKE USAGE ON SCHEMA public FROM darsly_audit;
-- -- REVOKE CONNECT ON DATABASE railway FROM darsly_audit;
-- -- DROP ROLE darsly_audit;

-- ════════════════════════════════════════════════════════════════════════
-- (B) The report as plain SELECTs. Replace the id if needed.
-- ════════════════════════════════════════════════════════════════════════

-- B1. Is the database in UTC? (The lease bug fixed in dc24155 only bites
--     when it is not.) And did the per-call table get deployed at all?
SHOW timezone;
SELECT to_regclass('public."AiCallLog"') IS NOT NULL AS ai_call_log_exists;

-- B2. The import: status, wall clock, recorded totals.
SELECT id, kind, status, stage, "createdAt", "updatedAt",
       EXTRACT(EPOCH FROM "updatedAt" - "createdAt") AS wall_seconds,
       "durationMs", "costCents", "inputTokens", "outputTokens",
       "escalatedPages", "highAccuracy"
FROM "PaperImport"
WHERE id = 'cmufelwqc0014a7pwsolbylps';

-- B3. Its job(s): queued when, finished when, and how many times it ran.
SELECT id, status, attempts, stage, "createdAt", "updatedAt",
       EXTRACT(EPOCH FROM "updatedAt" - "createdAt") AS job_seconds,
       "costCents", "errorClass"
FROM "AiJob"
WHERE input->>'importId' = 'cmufelwqc0014a7pwsolbylps'
ORDER BY "createdAt";

-- B4. Every model call, in order, with its offset from the upload.
SELECT
  ROUND(EXTRACT(EPOCH FROM c."startedAt" - i."createdAt")::numeric, 1) AS start_s,
  ROUND(c."latencyMs" / 1000.0, 1)                                    AS duration_s,
  c.stage, c.region, c.attempt, c.model, c."reasoningEffort",
  c."imageCount", c.status, LEFT(c.error, 120) AS error,
  c."inputTokens", c."cachedInputTokens", c."outputTokens", c."reasoningTokens",
  ROUND(c."costMillicents" / 1000.0, 3) AS cost_cents,
  c.meta->>'tier' AS tier, c.meta->>'rung' AS rung, c.meta->>'variant' AS variant,
  c."responseId"
FROM "AiCallLog" c
JOIN "PaperImport" i ON i.id = c."importId"
WHERE c."importId" = 'cmufelwqc0014a7pwsolbylps'
ORDER BY c."startedAt";

-- B5. Totals by model / effort / stage.
SELECT model, "reasoningEffort", stage,
       COUNT(*) AS calls,
       SUM("inputTokens") AS input, SUM("cachedInputTokens") AS cached,
       SUM("outputTokens") AS output, SUM("reasoningTokens") AS reasoning,
       ROUND(SUM("costMillicents") / 1000.0, 3) AS cost_cents,
       ROUND(SUM("latencyMs") / 1000.0, 1) AS call_seconds
FROM "AiCallLog"
WHERE "importId" = 'cmufelwqc0014a7pwsolbylps'
GROUP BY model, "reasoningEffort", stage
ORDER BY cost_cents DESC;
