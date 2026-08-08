#!/usr/bin/env bash
# Darsly SMS-listener device smoke — the full Android flow without a phone:
# admin-issued enrollment, device auth, sender rules, SMS event ingestion,
# idempotency, token rotation and revocation. Needs a SUPER_ADMIN login.
set -u
API=${API:-http://localhost:4000/api/v1}
export API   # the inline python helpers read it from the environment
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
post() { curl -s -X POST "$1" -H 'Content-Type: application/json' "${@:2}"; }

RND8=$(printf '%08d' $((RANDOM % 90000000 + 10000000)))
PHONE="010${RND8}"

# messageHash = SHA-256(normalizedSender + ' ' + body + ' ' + receivedAtEpochSec)
hash_of() { printf '%s %s %s' "$(echo "$1" | tr '[:upper:]' '[:lower:]')" "$2" "$3" | sha256sum | cut -d' ' -f1; }

ADMIN_EMAIL=${ADMIN_EMAIL:-admin@darsly.app}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-Darsly@123}

echo "── 1. Enrollment (admin mints a code, the handset redeems it)"
ADMIN=$(post $API/auth/login -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jget "['accessToken']")
check "admin logged in" "yes" "$([ -n "$ADMIN" ] && [ "$ADMIN" != ERR ] && echo yes || echo no)"

MINT=$(post $API/admin/device/enrollment-codes -H "Authorization: Bearer $ADMIN" -d "{\"phone\":\"$PHONE\",\"label\":\"smoke\"}")
CODE=$(echo "$MINT" | jget "['code']")
check "code minted"                "yes" "$([ -n "$CODE" ] && [ "$CODE" != ERR ] && echo yes || echo no)"
check "code is bound to the phone" "yes" "$(echo "$MINT" | jget "['phone']" | grep -q '^+20' && echo yes || echo no)"
check "minting requires admin → 401/403" "yes" "$(c=$(code -X POST $API/admin/device/enrollment-codes -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}"); [ "$c" = 401 ] || [ "$c" = 403 ] && echo yes || echo no)"
check "garbage code rejected → 400" "400" "$(code -X POST $API/device/auth/enroll -H 'Content-Type: application/json' -d '{"code":"ZZZZZZZZ"}')"

ENROLL=$(post $API/device/auth/enroll -d "{\"code\":\"$CODE\",\"model\":\"Smoke Test\",\"appVersion\":\"1.0.0\"}")
TOK=$(echo "$ENROLL" | jget "['accessToken']")
REFRESH=$(echo "$ENROLL" | jget "['refreshToken']")
DEVICE=$(echo "$ENROLL" | jget "['deviceId']")
check "enroll issues an access token" "yes" "$([ -n "$TOK" ] && [ "$TOK" != ERR ] && echo yes || echo no)"
check "enroll registers a device"     "yes" "$([ -n "$DEVICE" ] && [ "$DEVICE" != ERR ] && echo yes || echo no)"
check "phone comes from the code, not the client" "yes" "$(echo "$ENROLL" | jget "['phone']" | grep -q '^+20' && echo yes || echo no)"
check "code is single-use → 400" "400" "$(code -X POST $API/device/auth/enroll -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")"

echo "── 2. Device auth"
check "GET /device/me → 200"          "200" "$(code $API/device/me -H "Authorization: Bearer $TOK")"
check "no token → 401"                "401" "$(code $API/device/me)"
check "garbage token → 401"           "401" "$(code $API/device/me -H 'Authorization: Bearer not-a-jwt')"
check "heartbeat → 200"               "200" "$(code -X POST $API/device/heartbeat -H "Authorization: Bearer $TOK")"

echo "── 3. Sender rules are backend-driven"
RULES=$(curl -s $API/device/sms-rules -H "Authorization: Bearer $TOK")
check "rules are served"        "yes" "$(echo "$RULES" | jget "[0]['brand']" | grep -qv ERR && echo yes || echo no)"
check "rules carry a matchType" "yes" "$(echo "$RULES" | jget "[0]['matchType']" | grep -qE 'EXACT|CONTAINS|REGEX' && echo yes || echo no)"

echo "── 4. SMS event ingestion"
NOW=$(date -u +%s)
ISO=$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$NOW" +%Y-%m-%dT%H:%M:%SZ)
BODY="Your account was credited with EGP 450. Ref TXN-$RND8"
H=$(hash_of "CIB" "$BODY" "$NOW")
EV=$(post $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -d "{\"sender\":\"CIB\",\"message\":\"$BODY\",\"receivedAt\":\"$ISO\",\"messageHash\":\"$H\"}")
check "event accepted"                "yes"  "$([ "$(echo "$EV" | jget "['eventId']")" != ERR ] && echo yes || echo no)"
check "brand classified server-side"  "CIB"  "$(echo "$EV" | jget "['brand']")"
check "amount re-derived server-side" "45000" "$(echo "$EV" | jget "['amountCents']")"
check "forwarded to matching engine"  "True" "$(echo "$EV" | jget "['forwarded']")"

echo "── 5. Idempotency (the same SMS can never count twice)"
EV2=$(post $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -d "{\"sender\":\"CIB\",\"message\":\"$BODY\",\"receivedAt\":\"$ISO\",\"messageHash\":\"$H\"}")
check "re-POST reports duplicate" "True" "$(echo "$EV2" | jget "['duplicate']")"
check "duplicate keeps the same event id" "yes" \
  "$([ "$(echo "$EV2" | jget "['eventId']")" = "$(echo "$EV" | jget "['eventId']")" ] && echo yes || echo no)"

echo "── 6. Unknown senders stay local"
UB="Hello, are we still on for 8?"
UH=$(hash_of "+201009998877" "$UB" "$NOW")
UEV=$(post $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -d "{\"sender\":\"+201009998877\",\"message\":\"$UB\",\"receivedAt\":\"$ISO\",\"messageHash\":\"$UH\"}")
check "unknown sender → LOCAL_ONLY" "LOCAL_ONLY" "$(echo "$UEV" | jget "['status']")"
check "unknown sender not forwarded" "False"     "$(echo "$UEV" | jget "['forwarded']")"

echo "── 7. Validation"
check "missing messageHash → 400" "400" "$(code -X POST $API/device/sms-events -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"sender\":\"CIB\",\"message\":\"x\",\"receivedAt\":\"$ISO\"}")"
check "bad receivedAt → 400"      "400" "$(code -X POST $API/device/sms-events -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"sender\":\"CIB\",\"message\":\"x\",\"receivedAt\":\"not-a-date\",\"messageHash\":\"$H\"}")"

echo "── 8. Token rotation + revocation"
ROT=$(post $API/device/auth/refresh -d "{\"refreshToken\":\"$REFRESH\"}")
NEWTOK=$(echo "$ROT" | jget "['accessToken']")
check "refresh issues a new token" "yes" "$([ -n "$NEWTOK" ] && [ "$NEWTOK" != ERR ] && echo yes || echo no)"
check "reusing the old refresh token → 401" "401" "$(code -X POST $API/device/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}")"
check "reuse detection revoked the device → 401" "401" "$(code $API/device/me -H "Authorization: Bearer $NEWTOK")"

echo
echo "── Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
