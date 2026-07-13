#!/usr/bin/env sh
# Production start: apply migrations (self-healing from a failed migration /
# Prisma P3009), then boot the API. Runs with cwd = apps/api.
set -u

# Ensure strict config validation (see common/config.validation.ts) always runs
# on the deploy path, even if the host didn't set NODE_ENV.
export NODE_ENV="${NODE_ENV:-production}"

echo "→ prisma migrate deploy"
if npx prisma migrate deploy; then
  :
else
  echo "⚠ migrate deploy failed — one-time recovery: rolling back the known failed migration, then retrying."
  # The fixed migration is idempotent, so re-applying it after a rollback is safe.
  npx prisma migrate resolve --rolled-back 20260712190602_manual_payment_proof_accounts 2>/dev/null || true
  echo "→ prisma migrate deploy (retry)"
  if ! npx prisma migrate deploy; then
    echo "✗ migrate deploy still failing after recovery — refusing to boot on a drifted schema." >&2
    echo "  Inspect with: npx prisma migrate status" >&2
    exit 1
  fi
fi

# One-shot demo seed: set RUN_SEED_ON_BOOT=true in the host env to wipe + reseed
# the demo dataset on the next deploy, then REMOVE the var (otherwise every deploy
# re-wipes). Failure here never blocks the boot.
if [ "${RUN_SEED_ON_BOOT:-}" = "true" ]; then
  echo "⚠ RUN_SEED_ON_BOOT=true — seeding demo data (this WIPES existing data!)"
  npm run db:seed || echo "⚠ seed failed — continuing to boot anyway"
  echo "  → done. Remove RUN_SEED_ON_BOOT from the env so future deploys don't re-wipe."
fi

echo "→ starting API"
exec node dist/main.js
