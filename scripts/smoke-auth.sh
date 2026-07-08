#!/usr/bin/env bash
# Darsly Phase 1 smoke test: auth flows + RBAC + session control
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
# Fresh phone per run so the signup checks stay idempotent across re-runs.
SIGNUP_PHONE="0108$(shuf -i 1000000-9999999 -n1)"
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi
}

echo "── 1. Student OTP flow"
curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"01011111111"}' > /dev/null
R=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01011111111","code":"0000","deviceName":"smoke-device-1"}')
STUDENT_AT=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
STUDENT_RT=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("refreshToken",""))')
check "OTP verify returns access token" "yes" "$([ -n "$STUDENT_AT" ] && echo yes || echo no)"

ME_ROLE=$(curl -s $API/auth/me -H "Authorization: Bearer $STUDENT_AT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("role",""))')
check "GET /auth/me returns STUDENT" "STUDENT" "$ME_ROLE"

echo "── 2. New student signup requires name"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"'"$SIGNUP_PHONE"'","code":"0000"}')
check "signup without fullName → 400" "400" "$CODE"
R=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"'"$SIGNUP_PHONE"'","code":"0000","fullName":"طالب تجريبي"}')
NEW=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("isNewUser"))')
check "signup with fullName creates user" "True" "$NEW"

echo "── 3. Password login (teacher & admin) + RBAC"
ADMIN_AT=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"admin@darsly.app","password":"Admin@12345"}' | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
check "admin password login" "yes" "$([ -n "$ADMIN_AT" ] && echo yes || echo no)"

TR=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"khaled@darsly.app","password":"Teacher@12345"}')
TEACHER_AT=$(echo "$TR" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
TENANT=$(echo "$TR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["teacherProfile"]["id"][:6])')
check "teacher login carries tenant profile" "yes" "$([ -n "$TENANT" ] && echo yes || echo no)"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"admin@darsly.app","password":"WrongPass123"}')
check "wrong password → 401" "401" "$CODE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/catalog/subjects -H "Authorization: Bearer $STUDENT_AT" -H 'Content-Type: application/json' -d '{"nameAr":"تجربة","nameEn":"Test"}')
check "student POST subject → 403" "403" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/catalog/subjects -H "Authorization: Bearer $TEACHER_AT" -H 'Content-Type: application/json' -d '{"nameAr":"تجربة","nameEn":"Test"}')
check "teacher POST subject → 403" "403" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/catalog/subjects -H "Authorization: Bearer $ADMIN_AT" -H 'Content-Type: application/json' -d '{"nameAr":"مادة تجريبية","nameEn":"SmokeTest Subject"}')
check "admin POST subject → 201" "201" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/auth/me)
check "no token → 401" "401" "$CODE"

echo "── 4. Concurrent-session cap (max 2): 3rd login kicks oldest"
A1=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01022222222","code":"0000","deviceName":"device-A"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
A2=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01022222222","code":"0000","deviceName":"device-B"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
R3=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01022222222","code":"0000","deviceName":"device-C"}')
KICKED=$(echo "$R3" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("kickedSessions"))')
check "3rd login kicked 1 session" "1" "$KICKED"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/auth/me -H "Authorization: Bearer $A1")
check "kicked device token now rejected → 401" "401" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/auth/me -H "Authorization: Bearer $A2")
check "surviving device still works → 200" "200" "$CODE"

echo "── 5. Refresh rotation + reuse detection"
NR=$(curl -s -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$STUDENT_RT\"}")
NEW_RT=$(echo "$NR" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("refreshToken",""))')
check "refresh returns new pair" "yes" "$([ -n "$NEW_RT" ] && echo yes || echo no)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$STUDENT_RT\"}")
check "reusing old refresh token → 401 (session revoked)" "401" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$NEW_RT\"}")
check "rotated token also dead after reuse detection → 401" "401" "$CODE"

echo "── 6. Logout revokes session"
LT=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01033333333","code":"0000"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -X POST $API/auth/logout -H "Authorization: Bearer $LT" > /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/auth/me -H "Authorization: Bearer $LT")
check "token dead after logout → 401" "401" "$CODE"

echo
echo "RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
