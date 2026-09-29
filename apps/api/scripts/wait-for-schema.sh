#!/usr/bin/env sh
# Railway pre-deploy step for the live-recorder service
# (railway.recorder.json → preDeployCommand).
#
# The recorder runs the same code as the API but does NOT own migrations —
# the API's pre-deploy step does. Both services deploy from the same push, so
# this waits until the database has every migration this image knows about.
# It never migrates. Past the deadline it fails the deploy (the running
# recorder keeps serving) rather than start code against an older schema.
set -u
cd "$(dirname "$0")/.."

DEADLINE_SECONDS="${SCHEMA_WAIT_SECONDS:-900}"
started=$(date +%s)
while :; do
  if out=$(npx prisma migrate status 2>&1); then
    echo "✓ schema is current"
    exit 0
  fi
  now=$(date +%s)
  if [ $((now - started)) -ge "$DEADLINE_SECONDS" ]; then
    echo "✗ schema still not current after ${DEADLINE_SECONDS}s:" >&2
    echo "$out" >&2
    exit 1
  fi
  echo "… waiting for the API deploy to apply migrations ($((now - started))s)"
  sleep 10
done
