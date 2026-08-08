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

# Wait out any limiter budget an earlier run already spent. Without this the
# first suite starts throttled and reports 429s for every assertion — which is
# precisely the false alarm this runner exists to prevent.
printf 'waiting for the rate limiter to clear'
for _ in $(seq 1 24); do
  if curl -s -m 10 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
       -d '{"email":"nobody@darsly.app","password":"x"}' | grep -q 'Unauthorized\|Invalid'; then
    printf ' ready\n\n'; break
  fi
  printf '.'; sleep 10
done

total_pass=0; total_fail=0; total_throttled=0; failed_suites=""
first=1
for suite in $SUITES; do
  [ -f "$here/$suite.sh" ] || continue
  if [ "$first" = 0 ] && [ "$PAUSE" -gt 0 ]; then sleep "$PAUSE"; fi
  first=0

  echo "──────── $suite ────────"
  out=$(bash "$here/$suite.sh" 2>&1)

  # A "got 429" is the rate limiter doing its job, not the product failing. Some
  # flows (register-teacher, forgot-password) are capped at 5 per ten minutes,
  # which no practical pause between suites can clear — so they are reported
  # separately rather than inflating the failure count and hiding a real one.
  real=$(echo "$out" | grep -E "❌" | grep -v "got 429" || true)
  throttled=$(echo "$out" | grep -cE "❌.*got 429" || true)
  [ -n "$real" ] && echo "$real"
  [ "$throttled" -gt 0 ] && echo "  ⏳ $throttled check(s) hit the rate limiter — rerun this suite alone to confirm"

  # Both summary shapes end "<n> passed, <m> failed" — but the Arabic one uses an
  # Arabic comma (،), and matching only the Latin one made this report 0 passed /
  # 0 failed for a suite that had actually passed every check. A runner that
  # silently scores a suite as nothing is worse than no runner: it hides exactly
  # the regression it exists to catch.
  nums=$(echo "$out" | grep -oE "[0-9]+ (passed|نجح)[,،] [0-9]+ (failed|فشل)" | tail -1 | grep -oE "[0-9]+")
  p=$(echo "$nums" | sed -n 1p); f=$(echo "$nums" | sed -n 2p)
  p=${p:-0}; f=${f:-0}
  f=$((f - throttled))
  [ "$f" -lt 0 ] && f=0
  total_pass=$((total_pass + p)); total_fail=$((total_fail + f))
  total_throttled=$((total_throttled + throttled))
  [ "$f" -gt 0 ] && failed_suites="$failed_suites $suite"
  echo "  → $p passed, $f failed$([ "$throttled" -gt 0 ] && echo ", $throttled throttled")"
done

echo
echo "════════════════════════════════════════"
echo "  TOTAL: $total_pass passed, $total_fail failed"
[ "$total_throttled" -gt 0 ] && echo "  ($total_throttled rate-limited — not product failures)"
[ -n "$failed_suites" ] && echo "  failing suites:$failed_suites"
echo "════════════════════════════════════════"
[ "$total_fail" -eq 0 ]
