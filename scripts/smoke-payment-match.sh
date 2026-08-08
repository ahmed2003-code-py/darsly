#!/usr/bin/env bash
# Darsly auto-verification smoke — the whole point of the SMS listener:
# a student submits a transfer, the listener phone receives the wallet SMS, and
# the enrollment activates itself with nobody clicking "verify".
#
#   student submits payment (PENDING)
#        → device posts the wallet SMS
#             → server re-derives amount + reference from the raw body
#                  → matching engine finds the one pending payment
#                       → payment VERIFIED + enrollment ACTIVE
#
# Requires OTP_DEV_MODE=true (dev OTP "0000"). Usage: bash scripts/smoke-payment-match.sh
set -u
API=${API:-http://localhost:4000/api/v1}
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }
post() { curl -s -X POST "$1" -H 'Content-Type: application/json' "${@:2}"; }

RND=$(printf '%06d' $((RANDOM % 900000 + 100000)))
REF="TXN-$RND"
PHONE="010$(printf '%08d' $((RANDOM % 90000000 + 10000000)))"

echo "── 1. الطالب يقدّم تحويل (يفضل PENDING)"
# The demo dataset (common/demo-seed.ts) uses one password for every account.
# A random student each run, because a student already enrolled in the chosen
# course cannot submit a second payment for it.
STUDENT_EMAIL=${STUDENT_EMAIL:-student$((RANDOM % 10 + 1))@darsly.app}
STUDENT_PASSWORD=${STUDENT_PASSWORD:-Darsly@123}

ST=$(post $API/auth/login -d "{\"email\":\"$STUDENT_EMAIL\",\"password\":\"$STUDENT_PASSWORD\"}" | jget "['accessToken']")
check "student logged in" "yes" "$([ -n "$ST" ] && [ "$ST" != ERR ] && echo yes || echo no)"

# Any priced published course. Discovery goes through the public teacher page,
# walking the teacher list until one has a course with a price.
COURSE=${COURSE_ID:-$(curl -s "$API/teachers" | PICK=$RANDOM python3 -c "
import sys, json, urllib.request, os
api = os.environ['API']
found = []
try: d = json.load(sys.stdin)
except Exception: sys.exit()
rows = d if isinstance(d, list) else (d.get('items') or d.get('data') or [])
for t in rows[:6]:
    slug = t.get('slug')
    if not slug: continue
    try:
        with urllib.request.urlopen(f'{api}/teachers/{slug}', timeout=10) as r:
            page = json.load(r)
    except Exception:
        continue
    for c in page.get('courses') or []:
        if c.get('priceCents'):
            found.append(c['id'])
if found:
    print(found[int(os.environ.get('PICK', '0')) % len(found)])
" 2>/dev/null)}
check "found a published course" "yes" "$([ -n "$COURSE" ] && echo yes || echo no)"

SUB=$(post $API/payments -H "Authorization: Bearer $ST" \
  -d "{\"courseId\":\"$COURSE\",\"method\":\"VODAFONE_CASH\",\"proofImageUrl\":\"data:image/png;base64,iVBORw0KGgo=\",\"reference\":\"$REF\"}")
PAY_ID=$(echo "$SUB" | jget "['id']")
AMOUNT=$(echo "$SUB" | jget "['amountCents']")
check "payment submitted"        "yes" "$([ "$PAY_ID" != ERR ] && echo yes || echo no)"
[ "$PAY_ID" = ERR ] && echo "     ↳ رد الخادم: $(echo "$SUB" | head -c 200)"
check "payment starts PENDING"   "PENDING" "$(echo "$SUB" | jget "['status']")"
echo "     المبلغ: $AMOUNT قرش | المرجع: $REF"

echo "── 2. تسجيل جهاز الاستماع"
post $API/device/auth/request-otp -d "{\"phone\":\"$PHONE\"}" > /dev/null
TOK=$(post $API/device/auth/verify-otp -d "{\"phone\":\"$PHONE\",\"code\":\"0000\",\"model\":\"Match Smoke\"}" | jget "['accessToken']")
check "device registered" "yes" "$([ -n "$TOK" ] && [ "$TOK" != ERR ] && echo yes || echo no)"

echo "── 3. رسالة المحفظة توصل على الموبايل"
EGP=$(python3 -c "print(f'{$AMOUNT/100:.2f}')")
NOW=$(date -u +%s)
ISO=$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$NOW" +%Y-%m-%dT%H:%M:%SZ)
# Sender id is "VF-Cash" on purpose: the separator must not defeat the rule.
BODY="تم استلام مبلغ $EGP جنيه على محفظتك، رقم العملية $REF"
HASH=$(printf 'vf-cash %s %s' "$BODY" "$NOW" | sha256sum | cut -d' ' -f1)

EV=$(post $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -d "$(BODY="$BODY" ISO="$ISO" HASH="$HASH" python3 -c "
import json, os
print(json.dumps({'sender':'VF-Cash','message':os.environ['BODY'],
                  'receivedAt':os.environ['ISO'],'messageHash':os.environ['HASH'],
                  'simSlot':1,'subscriptionId':2}, ensure_ascii=False))")")

check "sender classified despite the hyphen" "Vodafone Cash" "$(echo "$EV" | jget "['brand']")"
check "amount re-derived by the server"      "$AMOUNT"       "$(echo "$EV" | jget "['amountCents']")"
check "reference re-derived by the server"   "$REF"          "$(echo "$EV" | jget "['reference']")"
check "forwarded to the matching engine"     "True"          "$(echo "$EV" | jget "['forwarded']")"

echo "── 4. المطابقة التلقائية"
check "event MATCHED" "MATCHED" "$(echo "$EV" | jget "['status']")"

MINE=$(curl -s $API/payments/mine -H "Authorization: Bearer $ST")
STATUS=$(echo "$MINE" | PAY="$PAY_ID" python3 -c "
import sys, json, os
rows = json.load(sys.stdin)
rows = rows if isinstance(rows, list) else (rows.get('items') or rows.get('data') or [])
print(next((r.get('status') for r in rows if r.get('id') == os.environ['PAY']), 'NOT_FOUND'))
" 2>/dev/null || echo ERR)
check "payment left PENDING behind" "yes" \
  "$([ -n "$STATUS" ] && [ "$STATUS" != 'PENDING' ] && [ "$STATUS" != 'NOT_FOUND' ] && [ "$STATUS" != ERR ] && echo yes || echo "no ($STATUS)")"
echo "     حالة الدفعة الآن: $STATUS"

ENROLLMENT=$(curl -s $API/enrollments/mine -H "Authorization: Bearer $ST" | COURSE="$COURSE" python3 -c "
import sys, json, os
rows = json.load(sys.stdin)
rows = rows if isinstance(rows, list) else (rows.get('items') or rows.get('data') or [])
course = os.environ['COURSE']
for r in rows:
    cid = r.get('courseId') or (r.get('course') or {}).get('id')
    if cid == course:
        print(r.get('status', 'UNKNOWN')); sys.exit()
print('NOT_FOUND')
" 2>/dev/null || echo ERR)
check "enrollment ACTIVE — the student can watch now" "ACTIVE" "$ENROLLMENT"

echo "── 5. عدم التكرار: نفس الرسالة تاني"
EV2=$(post $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -d "$(BODY="$BODY" ISO="$ISO" HASH="$HASH" python3 -c "
import json, os
print(json.dumps({'sender':'VF-Cash','message':os.environ['BODY'],
                  'receivedAt':os.environ['ISO'],'messageHash':os.environ['HASH']}, ensure_ascii=False))")")
check "re-POST reported as duplicate" "True" "$(echo "$EV2" | jget "['duplicate']")"

echo
echo "── النتيجة: $pass نجح، $fail فشل"
[ "$fail" -eq 0 ]
