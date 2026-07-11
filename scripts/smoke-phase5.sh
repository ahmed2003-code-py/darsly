#!/usr/bin/env bash
# Darsly Phase 5 smoke: ledger/wallet, payouts (teacher+admin), admin dashboard,
# teacher approvals, and Leak-Trace forensics.
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

echo "── 1. Logins"
KH=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"khaled@darsly.app","password":"Teacher@12345"}' | jget "['accessToken']")
ADMIN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"admin@darsly.app","password":"Admin@12345"}' | jget "['accessToken']")
check "admin login" "yes" "$([ -n "$ADMIN" ] && echo yes || echo no)"

echo "── 2. Teacher wallet (ledger-backed)"
W=$(curl -s $API/teacher/wallet -H "Authorization: Bearer $KH")
BAL=$(echo "$W" | jget "['balanceCents']")
NET=$(echo "$W" | jget "['netCents']")
COMM=$(echo "$W" | jget "['commissionCents']")
GROSS=$(echo "$W" | jget "['grossCents']")
check "wallet returns a balance" "yes" "$([ "$BAL" != "ERR" ] && [ "$BAL" -ge 0 ] 2>/dev/null && echo yes || echo no)"
check "gross = net + commission (balanced)" "$GROSS" "$((NET + COMM))"
check "wallet lists paid payments with invoice serial" "yes" "$(echo "$W" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if d['recentPayments'] and d['recentPayments'][0]['invoiceSerial'] else 'no')")"

echo "── 3. Payout request: minimum + balance guards"
METHOD=$(curl -s $API/teacher/payouts/methods -H "Authorization: Bearer $KH" | jget "[0]['id']")
check "teacher has a payout method" "yes" "$([ "$METHOD" != "ERR" ] && [ -n "$METHOD" ] && echo yes || echo no)"
# below minimum (min 50000)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/teacher/payouts -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"amountCents\":10000,\"methodId\":\"$METHOD\"}")
check "below-minimum payout → 400" "400" "$CODE"
# above balance
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/teacher/payouts -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"amountCents\":99999999,\"methodId\":\"$METHOD\"}")
check "over-balance payout → 400" "400" "$CODE"

echo "── 4. Admin overview + teacher approvals"
OV=$(curl -s $API/admin/overview -H "Authorization: Bearer $ADMIN")
check "overview has commission total" "yes" "$([ "$(echo "$OV" | jget "['commissionCents']")" != "ERR" ] && echo yes || echo no)"
check "overview counts pending teachers" "yes" "$([ "$(echo "$OV" | jget "['teachersPending']")" -ge 1 ] 2>/dev/null && echo yes || echo no)"
# approve the seeded pending teacher
PENDING_ID=$(curl -s "$API/admin/teachers?status=PENDING" -H "Authorization: Bearer $ADMIN" | jget "[0]['id']")
AP=$(curl -s -X PATCH $API/admin/teachers/$PENDING_ID/status -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"APPROVED"}' | jget "['status']")
check "admin approves pending teacher → APPROVED" "APPROVED" "$AP"
# revert so the smoke stays idempotent
curl -s -X PATCH $API/admin/teachers/$PENDING_ID/status -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"PENDING"}' > /dev/null

echo "── 5. Admin payout queue → complete → ledger booked"
PID=$(curl -s "$API/admin/payouts?status=REQUESTED" -H "Authorization: Bearer $ADMIN" | jget "[0]['id']")
check "admin sees a requested payout" "yes" "$([ "$PID" != "ERR" ] && [ -n "$PID" ] && echo yes || echo no)"
BAL_BEFORE=$(curl -s $API/teacher/wallet -H "Authorization: Bearer $KH" | jget "['balanceCents']")
curl -s -X PATCH $API/admin/payouts/$PID -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"status":"COMPLETED"}' > /dev/null
BAL_AFTER=$(curl -s $API/teacher/wallet -H "Authorization: Bearer $KH" | jget "['balanceCents']")
check "completing payout reduces balance by 60000" "60000" "$((BAL_BEFORE - BAL_AFTER))"

echo "── 6. RBAC: teacher cannot hit admin"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/admin/overview -H "Authorization: Bearer $KH")
check "teacher on /admin/overview → 403" "403" "$CODE"

echo "── 7. Leak-Trace: watermark → student"
# create a playback session by starting a lesson (needs a READY video on a free lesson)
COURSE=$(curl -s $API/teacher/courses -H "Authorization: Bearer $KH" | python3 -c 'import sys,json;print([x for x in json.load(sys.stdin) if "الجبر" in x["title"]][0]["id"])')
LESSON=$(curl -s $API/teacher/courses/$COURSE -H "Authorization: Bearer $KH" | python3 -c 'import sys,json
d=json.load(sys.stdin)
for u in d["units"]:
  for l in u["lessons"]:
    if l["isFreePreview"] and l.get("videoAsset"): print(l["id"]); import sys; sys.exit()')
if [ -n "$LESSON" ]; then
  curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"01011111111"}' > /dev/null
  ST=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01011111111","code":"0000"}' | jget "['accessToken']")
  WM=$(curl -s -X POST $API/playback/sessions -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"lessonId\":\"$LESSON\"}" | jget "['watermark']['watermarkId']")
  TRACE=$(curl -s $API/teacher/security/trace/$WM -H "Authorization: Bearer $KH")
  check "leak-trace resolves watermark to a student name" "yes" "$([ "$(echo "$TRACE" | jget "['student']['name']")" != "ERR" ] && echo yes || echo no)"
else
  echo "  ⚠ skipped leak-trace (no READY free-preview video seeded)"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/teacher/security/trace/DRS-00000-XXXX -H "Authorization: Bearer $KH")
check "unknown watermark → 404" "404" "$CODE"

echo
echo "══════════════════════════════════"
echo " Phase 5 smoke: $pass passed, $fail failed"
echo "══════════════════════════════════"
exit $fail
