#!/usr/bin/env bash
# Run every smoke suite in sequence and print one summary.
#
# The pause between suites is not padding: login is rate-limited to 20/min and
# forgot-password to 5/10min, so suites run back-to-back exhaust the limiter and
# report dozens of 429s that look exactly like product failures. Anyone reading
# that output concludes the platform is broken when it is the harness tripping
# its own defences.
#
# Usage: bash scripts/smoke-all.sh [--fast]
#   --fast  skip the pauses (use only when the API has THROTTLE_DISABLED set)
set -u
API=${API:-http://localhost:4000/api/v1}
export API
PAUSE=${PAUSE:-65}
[ "${1:-}" = "--fast" ] && PAUSE=0

SUITES="smoke-auth smoke-phase2 smoke-phase6 smoke-device-sms smoke-payment-match"
here="$(cd "$(dirname "$0")" && pwd)"

if ! curl -s -m 10 -o /dev/null "$API/health"; then
  echo "✗ API is not reachable at $API — start it with: npm run dev:api"
  exit 1
fi

total_pass=0; total_fail=0; failed_suites=""
first=1
for suite in $SUITES; do
  [ -f "$here/$suite.sh" ] || continue
  if [ "$first" = 0 ] && [ "$PAUSE" -gt 0 ]; then sleep "$PAUSE"; fi
  first=0

  echo "──────── $suite ────────"
  out=$(bash "$here/$suite.sh" 2>&1)
  echo "$out" | grep -E "❌" || true

  # Both the English and Arabic summary lines end "<n> passed, <m> failed".
  nums=$(echo "$out" | grep -oE "[0-9]+ (passed|نجح), [0-9]+ (failed|فشل)" | tail -1 | grep -oE "[0-9]+")
  p=$(echo "$nums" | sed -n 1p); f=$(echo "$nums" | sed -n 2p)
  p=${p:-0}; f=${f:-0}
  total_pass=$((total_pass + p)); total_fail=$((total_fail + f))
  [ "$f" -gt 0 ] && failed_suites="$failed_suites $suite"
  echo "  → $p passed, $f failed"
done

echo
echo "════════════════════════════════════════"
echo "  TOTAL: $total_pass passed, $total_fail failed"
[ -n "$failed_suites" ] && echo "  failing suites:$failed_suites"
echo "════════════════════════════════════════"
[ "$total_fail" -eq 0 ]
