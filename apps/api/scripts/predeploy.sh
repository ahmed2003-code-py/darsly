#!/usr/bin/env sh
# Railway pre-deploy step (railway.json → preDeployCommand).
#
# The ONLY place migrations run in production. It runs in its own container
# before the new deployment starts: if it fails, the deploy fails and the
# running deployment keeps serving — nothing crash-loops on a bad migration.
# (Migrations used to run at every process start, in both the API and the
# live-recorder service, from scripts/start.sh.)
#
# railway.json applies to every service built from this repo (Railway no
# longer lets a service pick its own config file), so ownership is decided
# here: the API service migrates; any other service — live-recorder — only
# waits until the schema is current. Off Railway (no RAILWAY_SERVICE_NAME), it
# migrates, as a manual run would expect.
set -eu
cd "$(dirname "$0")/.."

MIGRATION_OWNER="@darsly/api"
if [ -n "${RAILWAY_SERVICE_NAME:-}" ] && [ "$RAILWAY_SERVICE_NAME" != "$MIGRATION_OWNER" ]; then
  echo "→ ${RAILWAY_SERVICE_NAME} does not own migrations (${MIGRATION_OWNER} does) — waiting for the schema"
  exec sh scripts/wait-for-schema.sh
fi

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
