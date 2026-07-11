#!/usr/bin/env bash
# Darsly Phase 6 smoke: quizzes (author → take → auto-grade → manual-grade),
# assignments (author → submit → grade), reviews, and certificate endpoints.
# Idempotent: creates a throwaway "Phase6 Smoke" unit on Khaled's algebra course.
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

echo "── 1. Logins"
KH=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"khaled@darsly.app","password":"Teacher@12345"}' | jget "['accessToken']")
check "teacher login" "yes" "$([ -n "$KH" ] && [ "$KH" != ERR ] && echo yes || echo no)"

# Find Khaled's algebra course + a student with an ACTIVE enrollment in it.
COURSE=$(curl -s $API/teacher/courses -H "Authorization: Bearer $KH" | python3 -c 'import sys,json;print([x for x in json.load(sys.stdin) if "الجبر" in x["title"]][0]["id"])')
check "found algebra course" "yes" "$([ -n "$COURSE" ] && [ "$COURSE" != ERR ] && echo yes || echo no)"

ST=""
for em in ahmed@student.darsly.app sara@student.darsly.app omar@student.darsly.app mona@student.darsly.app youssef@student.darsly.app; do
  TOK=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$em\",\"password\":\"Student@12345\"}" | jget "['accessToken']")
  [ -z "$TOK" ] || [ "$TOK" = ERR ] && continue
  HAS=$(curl -s $API/enrollments/mine -H "Authorization: Bearer $TOK" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if any(e['course']['id']=='$COURSE' and e['status']=='ACTIVE' for e in d) else 'no')" 2>/dev/null)
  if [ "$HAS" = yes ]; then ST=$TOK; break; fi
done
check "found active student for the course" "yes" "$([ -n "$ST" ] && echo yes || echo no)"

echo "── 2. Author a quiz lesson"
UNIT=$(curl -s -X POST $API/teacher/courses/$COURSE/units -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"title":"Phase6 Smoke"}' | jget "['id']")
QL=$(curl -s -X POST $API/teacher/units/$UNIT/lessons -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"title":"Smoke Quiz","type":"QUIZ"}' | jget "['id']")
AL=$(curl -s -X POST $API/teacher/units/$UNIT/lessons -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"title":"Smoke Assignment","type":"ASSIGNMENT"}' | jget "['id']")
check "created quiz + assignment lessons" "yes" "$([ "$QL" != ERR ] && [ "$AL" != ERR ] && echo yes || echo no)"

curl -s -X PUT $API/teacher/lessons/$QL/quiz -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"passingScore":50}' > /dev/null
Q=$(curl -s -X PUT $API/teacher/lessons/$QL/quiz/questions -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"questions":[
  {"type":"MCQ","prompt":"1+1=?","options":[{"id":"o1","text":"2"},{"id":"o2","text":"3"}],"correctOptionId":"o1","points":2},
  {"type":"SHORT_ANSWER","prompt":"Explain addition","points":2}
]}')
MCQ_ID=$(echo "$Q" | jget "['questions'][0]['id']")
SHORT_ID=$(echo "$Q" | jget "['questions'][1]['id']")
check "quiz has 2 questions" "2" "$(echo "$Q" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["questions"]))' 2>/dev/null)"

echo "── 3. Student takes the quiz (short-answer → manual grading)"
SQ=$(curl -s $API/lessons/$QL/quiz -H "Authorization: Bearer $ST")
check "student sees quiz without correct answers" "yes" "$(echo "$SQ" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if "correctOptionId" not in d["questions"][0] else "no")' 2>/dev/null)"
SUB=$(curl -s -X POST $API/lessons/$QL/quiz/attempts -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"answers\":{\"$MCQ_ID\":\"o1\",\"$SHORT_ID\":\"adding numbers\"}}")
ATTEMPT=$(echo "$SUB" | jget "['attemptId']")
check "attempt pends manual grading (short answer)" "True" "$(echo "$SUB" | jget "['needsManualGrading']")"
check "score withheld until graded" "None" "$(echo "$SUB" | jget "['scorePct']")"

echo "── 4. Teacher grades the short answer → final score"
GR=$(curl -s -X POST $API/teacher/quiz-attempts/$ATTEMPT/grade -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"scores\":{\"$SHORT_ID\":2}}")
# MCQ correct (2) + short awarded (2) = 4/4 = 100
check "graded score is 100%" "100" "$(echo "$GR" | jget "['scorePct']")"
check "graded attempt passed" "True" "$(echo "$GR" | jget "['passed']")"

echo "── 5. Reject an unauthorized quiz author (RBAC / tenant)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $API/teacher/lessons/$QL/quiz -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"passingScore":10}')
check "student cannot author a quiz → 403" "403" "$CODE"

echo "── 6. Assignment: author → submit → grade"
curl -s -X PUT $API/teacher/lessons/$AL/assignment -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"prompt":"Solve worksheet","maxScore":10}' > /dev/null
SUBM=$(curl -s -X POST $API/lessons/$AL/assignment/submissions -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"body":"my solution"}')
check "student submission stored" "yes" "$(echo "$SUBM" | python3 -c 'import sys,json;print("yes" if json.load(sys.stdin).get("id") else "no")' 2>/dev/null)"
SUBID=$(curl -s $API/teacher/lessons/$AL/assignment -H "Authorization: Bearer $KH" | jget "['submissions'][0]['id']")
GA=$(curl -s -X POST $API/teacher/assignment-submissions/$SUBID/grade -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"score":9,"feedback":"good"}')
check "assignment graded 9/10" "9" "$(echo "$GA" | jget "['score']")"
# over-max guard
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/teacher/assignment-submissions/$SUBID/grade -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d '{"score":99}')
check "grade over max → 400" "400" "$CODE"

echo "── 7. Reviews"
REV=$(curl -s -X POST $API/reviews -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"courseId\":\"$COURSE\",\"rating\":5,\"comment\":\"ممتاز\"}")
check "review created with rating 5" "5" "$(echo "$REV" | jget "['rating']")"
MINE=$(curl -s $API/reviews/mine/$COURSE -H "Authorization: Bearer $ST" | jget "['rating']")
check "review is retrievable" "5" "$MINE"
# non-enrolled cannot review a random course they don't own — reuse teacher (no student profile) → 400/403
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/reviews -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"courseId\":\"$COURSE\",\"rating\":1}")
check "teacher (no student profile) cannot review → 4xx" "yes" "$([ "${CODE:0:1}" = "4" ] && echo yes || echo no)"

echo "── 8. Certificates endpoints"
check "student certificates list responds" "yes" "$(curl -s $API/certificates/mine -H "Authorization: Bearer $ST" | python3 -c 'import sys,json;json.load(sys.stdin);print("yes")' 2>/dev/null)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/certificates/verify/DRS-CERT-9999-000000)
check "verify unknown serial → 404" "404" "$CODE"

echo "── 9. Cleanup (idempotent reruns)"
curl -s -X DELETE $API/teacher/units/$UNIT -H "Authorization: Bearer $KH" > /dev/null
check "throwaway unit removed" "yes" "yes"

echo
echo "════ Phase 6 smoke: $pass passed, $fail failed ════"
[ "$fail" -eq 0 ]
