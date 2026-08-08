#!/usr/bin/env bash
# Darsly Academy Studio smoke — does the AI actually design, and differently?
#
# Runs real generations against the live model (costs a few cents each) and
# checks that the model's own design system reaches the document and the
# rendered page, and that two runs for the SAME teacher do not come out
# identical. Unit tests cannot prove this: they pin the renderer's behaviour
# given tokens, not that the model is allowed to choose them.
#
# Usage: bash scripts/smoke-academy-ai.sh [runs]      (default 2)
set -u
API=${API:-http://localhost:4000/api/v1}
RUNS=${1:-2}
TEACHER=${TEACHER:-teacher1@darsly.app}
PW=${DARSLY_PW:-Darsly@123}
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

T=$(curl -s -m 20 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
      -d "{\"email\":\"$TEACHER\",\"password\":\"$PW\"}" | jget "['accessToken']")
if [ -z "$T" ] || [ "$T" = ERR ]; then echo "✗ could not sign in as $TEACHER"; exit 1; fi

designs=""
for i in $(seq 1 "$RUNS"); do
  echo "── generation $i"
  JOB=$(curl -s -m 30 -X POST "$API/academy/site/generate" -H "Authorization: Bearer $T" \
          -H 'Content-Type: application/json' -d '{}' | jget "['id']")
  if [ "$JOB" = ERR ]; then fail=$((fail+1)); echo "  ❌ could not queue a generation"; continue; fi

  for _ in $(seq 1 60); do
    STATE=$(curl -s -m 20 "$API/academy/site/jobs/$JOB" -H "Authorization: Bearer $T")
    echo "$STATE" | grep -qE '"status":"(SUCCEEDED|FAILED|CANCELLED)"' && break
    sleep 5
  done
  ST=$(echo "$STATE" | jget "['status']")
  check "generation $i succeeded" "SUCCEEDED" "$ST"
  [ "$ST" = SUCCEEDED ] || { echo "     ↳ $(echo "$STATE" | jget "['error']" | head -c 200)"; continue; }

  DOC=$(curl -s -m 20 "$API/academy/site/draft" -H "Authorization: Bearer $T")
  D=$(echo "$DOC" | python3 -c "
import sys, json
doc = json.load(sys.stdin).get('doc') or {}
print(json.dumps((doc.get('theme') or {}).get('design') or {}, sort_keys=True))" 2>/dev/null || echo '{}')

  check "run $i: the model composed a design system" "yes" "$([ "$D" != '{}' ] && echo yes || echo no)"
  if [ "$D" != '{}' ]; then
    echo "     $D"
    designs="$designs$D
"
  fi
done

if [ "$RUNS" -gt 1 ]; then
  UNIQ=$(printf '%s' "$designs" | sort -u | grep -c . || true)
  # The whole point: the same teacher, generated twice, must not come out
  # identical. Identical output means the model's answer is being discarded
  # somewhere — which is exactly the bug this suite was written to catch.
  check "consecutive runs differ" "yes" "$([ "$UNIQ" -gt 1 ] && echo yes || echo no)"
fi

# The tokens must survive into the page, not just the document.
HTML=$(curl -s -m 25 "$API/academy/site/preview" -H "Authorization: Bearer $T")
check "preview renders the composed palette" "yes" \
  "$(echo "$HTML" | grep -qE '\-\-pad:(68|104|148)px' && echo yes || echo no)"

echo
echo "── Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
