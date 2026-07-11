#!/usr/bin/env bash
# Darsly auth smoke — email + password model:
# login, registration (student immediate / teacher pending), password strength,
# failed-login lockout, forgot/reset password (dev token), RBAC, sessions.
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
login() { curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "$1"; }
RND=$RANDOM
RND8=$(printf '%08d' $((RANDOM % 90000000 + 10000000)))  # valid 010XXXXXXXX phone tail

echo "── 1. Seeded logins (email + password)"
ADMIN=$(login '{"email":"admin@darsly.app","password":"Admin@12345"}' | jget "['accessToken']")
KH=$(login '{"email":"khaled@darsly.app","password":"Teacher@12345"}' | jget "['accessToken']")
ST=$(login '{"email":"ahmed@student.darsly.app","password":"Student@12345"}' | jget "['accessToken']")
check "admin login"   "yes" "$([ -n "$ADMIN" ] && [ "$ADMIN" != ERR ] && echo yes || echo no)"
check "teacher login" "yes" "$([ -n "$KH" ] && [ "$KH" != ERR ] && echo yes || echo no)"
check "student login" "yes" "$([ -n "$ST" ] && [ "$ST" != ERR ] && echo yes || echo no)"

echo "── 2. Bad credentials + validation"
check "wrong password → 401" "401" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"ahmed@student.darsly.app","password":"nope12345"}')"
check "unknown email → 401"   "401" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"ghost@darsly.app","password":"whatever12"}')"
check "malformed email → 400" "400" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"not-an-email","password":"whatever12"}')"

echo "── 3. PENDING teacher cannot log in"
check "pending teacher → 403" "403" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"pending@darsly.app","password":"Teacher@12345"}')"

echo "── 4. Student self-registration (immediate) + auto-login"
SEMAIL="stud_$RND@test.com"
REG=$(curl -s -X POST $API/auth/register/student -H 'Content-Type: application/json' -d "{\"email\":\"$SEMAIL\",\"password\":\"Passw0rd1\",\"fullName\":\"طالب اختبار\"}")
check "student register returns token" "yes" "$([ "$(echo "$REG" | jget "['accessToken']")" != ERR ] && echo yes || echo no)"
check "new user is STUDENT" "STUDENT" "$(echo "$REG" | jget "['user']['role']")"
check "duplicate email → 409" "409" "$(code -X POST $API/auth/register/student -H 'Content-Type: application/json' -d "{\"email\":\"$SEMAIL\",\"password\":\"Passw0rd1\",\"fullName\":\"طالب مكرر\"}")"
check "weak password → 400" "400" "$(code -X POST $API/auth/register/student -H 'Content-Type: application/json' -d '{"email":"weak_'$RND'@test.com","password":"short","fullName":"x"}')"

echo "── 5. Teacher registration → pending (no token, cannot log in)"
TEMAIL="teach_$RND@test.com"
TREG=$(curl -s -X POST $API/auth/register/teacher -H 'Content-Type: application/json' -d "{\"email\":\"$TEMAIL\",\"password\":\"Passw0rd1\",\"fullName\":\"معلم اختبار\",\"phone\":\"010${RND8}\"}")
check "teacher register → pending flag" "True" "$(echo "$TREG" | jget "['pending']")"
check "teacher register issues no token" "yes" "$([ "$(echo "$TREG" | jget "['accessToken']")" = ERR ] && echo yes || echo no)"
check "fresh teacher cannot log in (pending) → 403" "403" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$TEMAIL\",\"password\":\"Passw0rd1\"}")"

echo "── 6. Forgot / reset password (single-use)"
FTOK=$(curl -s -X POST $API/auth/forgot-password -H 'Content-Type: application/json' -d "{\"email\":\"$SEMAIL\"}" | jget "['devResetToken']")
check "forgot returns a dev token" "yes" "$([ -n "$FTOK" ] && [ "$FTOK" != ERR ] && echo yes || echo no)"
check "reset with token → 200" "200" "$(code -X POST $API/auth/reset-password -H 'Content-Type: application/json' -d "{\"token\":\"$FTOK\",\"password\":\"NewPass123\"}")"
check "login with new password → 200" "200" "$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$SEMAIL\",\"password\":\"NewPass123\"}")"
check "reusing reset token → 400" "400" "$(code -X POST $API/auth/reset-password -H 'Content-Type: application/json' -d "{\"token\":\"$FTOK\",\"password\":\"NewPass123\"}")"
check "forgot unknown email still → 200 (no enumeration)" "200" "$(code -X POST $API/auth/forgot-password -H 'Content-Type: application/json' -d '{"email":"nobody@darsly.app"}')"

echo "── 7. RBAC + session"
check "student on /admin/overview → 403" "403" "$(code $API/admin/overview -H "Authorization: Bearer $ST")"
check "admin on /admin/overview → 200" "200" "$(code $API/admin/overview -H "Authorization: Bearer $ADMIN")"
check "no token on /auth/me → 401" "401" "$(code $API/auth/me)"
check "/auth/me with token → 200" "200" "$(code $API/auth/me -H "Authorization: Bearer $ST")"

echo "── 8. Failed-login lockout (brute-force defense: throttle or soft-lock)"
LEMAIL="lock_$RND@test.com"
curl -s -X POST $API/auth/register/student -H 'Content-Type: application/json' -d "{\"email\":\"$LEMAIL\",\"password\":\"Passw0rd1\",\"fullName\":\"قفل الحساب\"}" > /dev/null
for i in $(seq 1 12); do code -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$LEMAIL\",\"password\":\"wrongpass9\"}" > /dev/null; done
LC=$(code -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$LEMAIL\",\"password\":\"Passw0rd1\"}")
check "correct password after 12 fails is blocked (403 lock / 429 throttle)" "yes" "$([ "$LC" = 403 ] || [ "$LC" = 429 ] && echo yes || echo no)"

echo
echo "════ Auth smoke: $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
