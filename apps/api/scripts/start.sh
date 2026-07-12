#!/usr/bin/env sh
# Production start: apply migrations (self-healing from a failed migration /
# Prisma P3009), then boot the API. Runs with cwd = apps/api.
set -u

echo "→ prisma migrate deploy"
if npx prisma migrate deploy; then
  :
else
  echo "⚠ migrate deploy failed — one-time recovery: rolling back the known failed migration, then retrying."
  # The fixed migration is idempotent, so re-applying it after a rollback is safe.
  npx prisma migrate resolve --rolled-back 20260712190602_manual_payment_proof_accounts 2>/dev/null || true
  echo "→ prisma migrate deploy (retry)"
  npx prisma migrate deploy
fi

echo "→ starting API"
exec node dist/main.js
