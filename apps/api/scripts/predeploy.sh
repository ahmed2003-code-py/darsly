#!/usr/bin/env sh
# Railway pre-deploy step for the API service (railway.json → preDeployCommand).
#
# The ONLY place migrations run in production. It runs in its own container
# before the new deployment starts: if it fails, the deploy fails and the
# running deployment keeps serving — nothing crash-loops on a bad migration.
# (Migrations used to run at every process start, in both the API and the
# live-recorder service, from scripts/start.sh.)
set -eu
cd "$(dirname "$0")/.."

echo "→ prisma migrate deploy"
npx prisma migrate deploy

# One-shot demo seed: set RUN_SEED_ON_BOOT=true in the host env to wipe + reseed
# the demo dataset on the next deploy, then REMOVE the var (otherwise every
# deploy re-wipes). A seed failure never blocks the deploy.
if [ "${RUN_SEED_ON_BOOT:-}" = "true" ]; then
  echo "⚠ RUN_SEED_ON_BOOT=true — seeding demo data (this WIPES existing data!)"
  npm run db:seed || echo "⚠ seed failed — continuing"
  echo "  → done. Remove RUN_SEED_ON_BOOT from the env so future deploys don't re-wipe."
fi
