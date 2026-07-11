#!/usr/bin/env bash
# Darsly Phase 2 smoke test: discovery, course CRUD + tenant isolation,
# uploads, coupons, enrollment lifecycle (quote → enroll → approve → revoke).
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi
}
jsonget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo "ERR"; }
# Per-run fixtures so the script is safe to re-run (no unique-constraint residue).
RUN_CODE="SMOKE$RANDOM"
RUN_EMAIL="smoke_$RANDOM@test.com"

echo "── 1. Public discovery"
R=$(curl -s "$API/teachers")
TOTAL=$(echo "$R" | jsonget "['total']")
check "discovery lists 3 approved teachers" "3" "$TOTAL"
HAS_PENDING=$(echo "$R" | python3 -c 'import sys,json;print(any(t["slug"]=="pending-teacher" for t in json.load(sys.stdin)["items"]))')
check "PENDING teacher hidden" "False" "$HAS_PENDING"
EN=$(curl -s "$API/teachers?language=en" | jsonget "['total']")
check "language=en filter → 1" "1" "$EN"
Q=$(curl -s --get "$API/teachers" --data-urlencode "q=عبدالرحمن" | jsonget "['items'][0]['slug']")
check "search by Arabic name" "khaled-abdelrahman" "$Q"
RATED=$(curl -s "$API/teachers?minRating=4" | jsonget "['total']")
check "minRating=4 → 2 rated teachers" "2" "$RATED"

echo "── 2. Public teacher profile"
P=$(curl -s "$API/teachers/khaled-abdelrahman")
check "profile has students count (≥1)" "yes" "$([ "$(echo "$P" | jsonget "['stats']['studentsCount']")" -ge 1 ] 2>/dev/null && echo yes || echo no)"
check "profile avg rating 4.5" "4.5" "$(echo "$P" | jsonget "['stats']['avgRating']")"
check "profile lists published courses" "2" "$(echo "$P" | jsonget "['stats']['coursesCount']")"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/teachers/pending-teacher")
check "pending teacher profile → 404" "404" "$CODE"

echo "── 3. Teacher course CRUD + tenant isolation"
KH=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"khaled@darsly.app","password":"Teacher@12345"}' | jsonget "['accessToken']")
NO=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"noura@darsly.app","password":"Teacher@12345"}' | jsonget "['accessToken']")

C=$(curl -s -X POST $API/teacher/courses -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' \
  -d '{"title":"دورة تجريبية للاختبار","description":"smoke","priceCents":10000}')
CID=$(echo "$C" | jsonget "['id']")
check "create course → DRAFT" "DRAFT" "$(echo "$C" | jsonget "['status']")"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/teacher/courses/$CID -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"status":"PUBLISHED"}')
check "publish with no lessons → 400" "400" "$CODE"

U=$(curl -s -X POST $API/teacher/courses/$CID/units -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"title":"الوحدة الأولى"}')
UNIT_ID=$(echo "$U" | jsonget "['id']")
L=$(curl -s -X POST $API/teacher/units/$UNIT_ID/lessons -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' \
  -d '{"title":"درس مجاني","isFreePreview":true,"durationSec":600}')
LID=$(echo "$L" | jsonget "['id']")
L2=$(curl -s -X POST $API/teacher/units/$UNIT_ID/lessons -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' \
  -d '{"title":"درس مجدول","dripAfterEnrollDays":7,"durationSec":900}')
L2ID=$(echo "$L2" | jsonget "['id']")
check "lesson with drip created" "7" "$(echo "$L2" | jsonget "['dripAfterEnrollDays']")"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/teacher/courses/$CID -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"status":"PUBLISHED"}')
check "publish with lessons → 200" "200" "$CODE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/teacher/courses/$CID -H "Authorization: Bearer $NO" -H 'Content-Type: application/json' -d '{"title":"محاولة اختراق"}')
check "cross-tenant course edit → 404" "404" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/teacher/lessons/$LID -H "Authorization: Bearer $NO")
check "cross-tenant lesson delete → 404" "404" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/teacher/courses -H "Authorization: Bearer $KH" -X GET)
check "teacher lists own courses → 200" "200" "$CODE"

echo "── 4. Uploads"
printf '%%PDF-1.4 smoke attachment' > /tmp/darsly-smoke.pdf
A=$(curl -s -X POST $API/uploads/lessons/$LID/attachments -H "Authorization: Bearer $KH" -F "file=@/tmp/darsly-smoke.pdf;type=application/pdf;filename=ملخص.pdf")
AID=$(echo "$A" | jsonget "['id']")
check "attachment uploaded" "yes" "$([ "$AID" != "ERR" ] && [ -n "$AID" ] && echo yes || echo no)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/files/attachments/$AID -H "Authorization: Bearer $KH")
check "owner teacher downloads → 200" "200" "$CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/uploads/videos -H "Authorization: Bearer $KH" -F "file=@/tmp/darsly-smoke.pdf;type=application/pdf")
check "pdf as video rejected → 400" "400" "$CODE"

echo "── 5. Coupons + quote"
CP=$(curl -s -X POST $API/teacher/coupons -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"code\":\"$RUN_CODE\",\"percentOff\":50,\"maxUses\":5}")
check "coupon created" "$RUN_CODE" "$(echo "$CP" | jsonget "['code']")"
Q=$(curl -s -X POST $API/enrollments/quote -H 'Content-Type: application/json' -d "{\"courseId\":\"$CID\",\"couponCode\":\"$(echo $RUN_CODE | tr A-Z a-z)\"}")
check "quote applies 50% (10000→5000)" "5000" "$(echo "$Q" | jsonget "['totalCents']")"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/enrollments/quote -H 'Content-Type: application/json' -d "{\"courseId\":\"$CID\",\"couponCode\":\"NOPE\"}")
check "invalid coupon → 400" "400" "$CODE"

echo "── 6. Enrollment lifecycle"
ST=$(curl -s -X POST $API/auth/register/student -H 'Content-Type: application/json' -d "{\"email\":\"$RUN_EMAIL\",\"password\":\"Passw0rd1\",\"fullName\":\"طالب الاختبار\"}" | jsonget "['accessToken']")

E=$(curl -s -X POST $API/enrollments -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"courseId\":\"$CID\",\"couponCode\":\"$RUN_CODE\"}")
EID=$(echo "$E" | jsonget "['id']")
check "enroll (approval required) → PENDING_APPROVAL" "PENDING_APPROVAL" "$(echo "$E" | jsonget "['status']")"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/enrollments -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"courseId\":\"$CID\"}")
check "duplicate request → 409" "409" "$CODE"

D=$(curl -s "$API/courses/$CID" -H "Authorization: Bearer $ST")
check "pending student: preview lesson open" "False" "$(echo "$D" | jsonget "['units'][0]['lessons'][0]['locked']")"
check "pending student: paid lesson locked" "True" "$(echo "$D" | jsonget "['units'][0]['lessons'][1]['locked']")"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $API/teacher/enrollments/$EID/approve -H "Authorization: Bearer $NO")
check "cross-tenant approve → 404" "404" "$CODE"
AP=$(curl -s -X PATCH $API/teacher/enrollments/$EID/approve -H "Authorization: Bearer $KH")
check "owner approves → ACTIVE" "ACTIVE" "$(echo "$AP" | jsonget "['status']")"

D=$(curl -s "$API/courses/$CID" -H "Authorization: Bearer $ST")
check "active student has access" "True" "$(echo "$D" | jsonget "['viewer']['hasAccess']")"
check "drip lesson still locked (7 days)" "True" "$(echo "$D" | jsonget "['units'][0]['lessons'][1]['locked']")"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/files/attachments/$AID -H "Authorization: Bearer $ST")
check "enrolled student downloads attachment → 200" "200" "$CODE"

MINE=$(curl -s $API/enrollments/mine -H "Authorization: Bearer $ST")
check "student sees enrollment in /mine" "yes" "$(echo "$MINE" | python3 -c "import sys,json;print('yes' if any(e['id']=='$EID' for e in json.load(sys.stdin)) else 'no')")"

# Auto-approve course (noura's chem, requiresApproval=false)
CHEM=$(curl -s "$API/teachers/noura-alkhaled" | jsonget "['courses'][0]['id']")
E2=$(curl -s -X POST $API/enrollments -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"courseId\":\"$CHEM\"}")
check "auto-approve course → ACTIVE immediately" "ACTIVE" "$(echo "$E2" | jsonget "['status']")"
check "subscription gets expiry" "yes" "$([ "$(echo "$E2" | jsonget "['expiresAt']")" != "None" ] && echo yes || echo no)"

RV=$(curl -s -X PATCH $API/teacher/enrollments/$EID/revoke -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"reason":"smoke"}')
check "revoke → REVOKED" "REVOKED" "$(echo "$RV" | jsonget "['status']")"
D=$(curl -s "$API/courses/$CID" -H "Authorization: Bearer $ST")
check "revoked student loses access" "False" "$(echo "$D" | jsonget "['viewer']['hasAccess']")"

echo "── 7. Cleanup"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE $API/teacher/courses/$CID -H "Authorization: Bearer $KH")
check "delete smoke course (archives — has enrollments)" "200" "$CODE"

# Hard-delete this run's course graph so archived test courses don't pile up in
# the teacher's dashboard. Best-effort: only when the dev Postgres is reachable.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q darsly-postgres; then
  docker exec -i darsly-postgres psql -U darsly -d darsly >/dev/null 2>&1 <<SQL
DELETE FROM "Payment" WHERE "courseId"='$CID';
DELETE FROM "LessonProgress" WHERE "lessonId" IN (SELECT l.id FROM "Lesson" l JOIN "CourseUnit" u ON l."unitId"=u.id WHERE u."courseId"='$CID');
DELETE FROM "PlaybackSession" WHERE "lessonId" IN (SELECT l.id FROM "Lesson" l JOIN "CourseUnit" u ON l."unitId"=u.id WHERE u."courseId"='$CID');
DELETE FROM "Enrollment" WHERE "courseId"='$CID';
DELETE FROM "Attachment" WHERE "lessonId" IN (SELECT l.id FROM "Lesson" l JOIN "CourseUnit" u ON l."unitId"=u.id WHERE u."courseId"='$CID');
DELETE FROM "Lesson" WHERE "unitId" IN (SELECT id FROM "CourseUnit" WHERE "courseId"='$CID');
DELETE FROM "CourseUnit" WHERE "courseId"='$CID';
DELETE FROM "Coupon" WHERE "courseId"='$CID' OR ("tenantId" IN (SELECT "tenantId" FROM "Course" WHERE id='$CID') AND code LIKE 'SMOKE%');
DELETE FROM "Course" WHERE id='$CID';
SQL
  echo "  🧹 smoke course hard-deleted (dev DB)"
fi

echo
echo "══════════════════════════════════"
echo " Phase 2 smoke: $pass passed, $fail failed"
echo "══════════════════════════════════"
exit $fail
