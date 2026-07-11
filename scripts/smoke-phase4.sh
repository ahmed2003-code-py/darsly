#!/usr/bin/env bash
# Darsly Phase 4 smoke: chat (REST + guards), progress/streaks, notifications.
# Realtime socket delivery is covered by the Node socket check in the repo;
# this script exercises the REST surface + authorization + notification writes.
set -u
API=http://localhost:4000/api/v1
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

echo "── 1. Logins"
KH=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"khaled@darsly.app","password":"Teacher@12345"}' | jget "['accessToken']")
# ahmed (student[0]) is enrolled in khaled's algebra course
ST=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"ahmed@student.darsly.app","password":"Student@12345"}' | jget "['accessToken']")
# yousef (student[4]) is NOT enrolled with khaled
YS=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"youssef@student.darsly.app","password":"Student@12345"}' | jget "['accessToken']")
KH_TENANT=$(curl -s $API/teacher/profile -H "Authorization: Bearer $KH" | jget "['id']")
check "teacher tenant resolved" "yes" "$([ -n "$KH_TENANT" ] && echo yes || echo no)"

echo "── 2. Student starts a chat with an enrolled teacher"
MSG=$(curl -s -X POST $API/chat/messages -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"tenantId\":\"$KH_TENANT\",\"body\":\"سؤال عن الدرس الأول\"}")
TID=$(echo "$MSG" | jget "['threadId']")
check "message sent → thread created" "yes" "$([ -n "$TID" ] && [ "$TID" != "ERR" ] && echo yes || echo no)"
check "message body echoed" "سؤال عن الدرس الأول" "$(echo "$MSG" | jget "['message']['body']")"

echo "── 3. Enrollment gate: non-enrolled student blocked"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/chat/messages -H "Authorization: Bearer $YS" -H 'Content-Type: application/json' -d "{\"tenantId\":\"$KH_TENANT\",\"body\":\"مرحبا\"}")
check "non-enrolled student → 403" "403" "$CODE"

echo "── 4. Teacher sees the thread + replies"
TCOUNT=$(curl -s $API/chat/threads -H "Authorization: Bearer $KH" | python3 -c "import sys,json;print(len([t for t in json.load(sys.stdin) if t['id']=='$TID']))")
check "teacher sees the thread" "1" "$TCOUNT"
RMSG=$(curl -s -X POST $API/chat/messages -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"threadId\":\"$TID\",\"body\":\"أهلاً، اتفضل\"}")
check "teacher reply persisted" "أهلاً، اتفضل" "$(echo "$RMSG" | jget "['message']['body']")"

echo "── 5. Messages list + read state"
MCOUNT=$(curl -s $API/chat/threads/$TID/messages -H "Authorization: Bearer $ST" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
check "student sees both messages" "2" "$MCOUNT"

echo "── 6. Chat message created a notification for the recipient"
# teacher should have a CHAT_MESSAGE notification from the student's message
NOTIF=$(curl -s $API/notifications -H "Authorization: Bearer $KH" | python3 -c "import sys,json
d=json.load(sys.stdin)
print(sum(1 for n in d['items'] if n['type']=='CHAT_MESSAGE'))")
check "teacher has ≥1 chat notification" "yes" "$([ "$NOTIF" -ge 1 ] 2>/dev/null && echo yes || echo no)"

echo "── 7. Cross-tenant thread access blocked"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/chat/threads/$TID/messages -H "Authorization: Bearer $YS")
check "outsider reading thread → 403" "403" "$CODE"

echo "── 8. Progress summary + weekly goal"
SUM=$(curl -s $API/progress/summary -H "Authorization: Bearer $ST")
check "summary has weeklyGoalLessons" "yes" "$([ "$(echo "$SUM" | jget "['weeklyGoalLessons']")" != "ERR" ] && echo yes || echo no)"
NEWGOAL=$(curl -s -X PATCH $API/progress/weekly-goal -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"goal":7}' | jget "['weeklyGoalLessons']")
check "weekly goal updated to 7" "7" "$NEWGOAL"

echo "── 9. Continue-watching endpoint responds"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/progress/continue-watching -H "Authorization: Bearer $ST")
check "continue-watching → 200" "200" "$CODE"

echo "── 10. Teacher blocked from student-only progress"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/progress/summary -H "Authorization: Bearer $KH")
check "teacher on /progress/summary → 403" "403" "$CODE"

echo
echo "══════════════════════════════════"
echo " Phase 4 smoke: $pass passed, $fail failed"
echo "══════════════════════════════════"
exit $fail
