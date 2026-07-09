#!/usr/bin/env bash
# Darsly Phase 3 smoke test: encrypted-HLS pipeline + signed URLs + key gating
# + playback session/access control + anomaly logging.
# Requires a running API and a generated sample video at $SAMPLE (default below).
set -u
API=http://localhost:4000/api/v1
SAMPLE=${SAMPLE:-/tmp/claude-1000/-home-ahmedeldeeb-darsly/c193dbc6-9884-416e-95bf-568dd9598e04/scratchpad/sample.mp4}
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✅ $1"; else fail=$((fail+1)); echo "  ❌ $1 (expected $2, got $3)"; fi; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(\"d$1\"))" 2>/dev/null || echo ERR; }

echo "── 1. Teacher uploads a video → transcodes to encrypted HLS"
KH=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"emailOrPhone":"khaled@darsly.app","password":"Teacher@12345"}' | jget "['accessToken']")
UP=$(curl -s -X POST $API/uploads/videos -H "Authorization: Bearer $KH" -F "file=@$SAMPLE;type=video/mp4")
AID=$(echo "$UP" | jget "['id']")
check "upload accepted, status PROCESSING" "PROCESSING" "$(echo "$UP" | jget "['status']")"

STATUS=PROCESSING
for i in $(seq 1 40); do
  STATUS=$(curl -s $API/uploads/videos/$AID/status -H "Authorization: Bearer $KH" | jget "['status']")
  [ "$STATUS" = "READY" ] && break
  [ "$STATUS" = "FAILED" ] && break
  sleep 1
done
check "asset transcoded to READY" "READY" "$STATUS"
RC=$(curl -s $API/uploads/videos/$AID/status -H "Authorization: Bearer $KH" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("renditions",[])))')
check "at least one HLS rendition produced" "yes" "$([ "$RC" -ge 1 ] 2>/dev/null && echo yes || echo no)"

echo "── 2. Attach video to Khaled's free-preview lesson"
COURSE=$(curl -s $API/teacher/courses -H "Authorization: Bearer $KH" | python3 -c 'import sys,json
d=json.load(sys.stdin)
c=[x for x in d if "الجبر" in x["title"]][0]
print(c["id"])')
LESSON=$(curl -s $API/teacher/courses/$COURSE -H "Authorization: Bearer $KH" | python3 -c 'import sys,json
d=json.load(sys.stdin)
for u in d["units"]:
  for l in u["lessons"]:
    if l["isFreePreview"]:
      print(l["id"]); break
  else: continue
  break')
curl -s -X PATCH $API/teacher/lessons/$LESSON -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"videoAssetId\":\"$AID\"}" > /dev/null
check "video attached to lesson" "yes" "$([ -n "$LESSON" ] && echo yes || echo no)"

echo "── 3. Student starts a protected playback session"
curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"01011111111"}' > /dev/null
ST=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01011111111","code":"0000","deviceName":"p3-smoke"}' | jget "['accessToken']")
TICKET=$(curl -s -X POST $API/playback/sessions -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "{\"lessonId\":\"$LESSON\"}")
PSID=$(echo "$TICKET" | jget "['playbackSessionId']")
MASTER=$(echo "$TICKET" | jget "['masterUrl']")
KEYURL=$(echo "$TICKET" | jget "['keyUrl']")
WM=$(echo "$TICKET" | jget "['watermark']['watermarkId']")
check "ticket has watermark id (DRS-...)" "yes" "$(echo "$WM" | grep -q '^DRS-' && echo yes || echo no)"
check "ticket carries student name in watermark" "أحمد محمود" "$(echo "$TICKET" | jget "['watermark']['studentName']")"
check "scheme is native AES clearkey" "AES_128_CLEARKEY" "$(echo "$TICKET" | jget "['scheme']")"

echo "── 4. Signed HLS delivery + key gating"
MCODE=$(curl -s -o /tmp/p3_master.m3u8 -w '%{http_code}' "http://localhost:4000$MASTER")
check "master playlist served (signed) → 200" "200" "$MCODE"
check "master lists a rendition" "yes" "$(grep -q 'EXT-X-STREAM-INF' /tmp/p3_master.m3u8 && echo yes || echo no)"
REND=$(grep -v '^#' /tmp/p3_master.m3u8 | head -1 | tr -d '\r')   # e.g. 360p/index.m3u8
RENDDIR=$(dirname "$REND")                                        # e.g. 360p
BASEURL="http://localhost:4000${MASTER%/master.m3u8}"
curl -s -o /tmp/p3_media.m3u8 "$BASEURL/$REND"
check "media playlist rewrites key URI to key endpoint" "yes" "$(grep -q 'playback/key/' /tmp/p3_media.m3u8 && echo yes || echo no)"
check "media playlist has no placeholder key uri" "yes" "$(grep -q 'darsly:key' /tmp/p3_media.m3u8 && echo no || echo yes)"
# Segments are relative to the media playlist, so live under the rendition dir.
SEG=$(grep -v '^#' /tmp/p3_media.m3u8 | grep '.ts' | head -1 | tr -d '\r')
SEGCODE=$(curl -s -o /tmp/p3_seg.ts -w '%{http_code}' "$BASEURL/$RENDDIR/$SEG")
check "encrypted segment served → 200" "200" "$SEGCODE"
check "segment is non-empty" "yes" "$([ -s /tmp/p3_seg.ts ] && echo yes || echo no)"

KCODE=$(curl -s -o /tmp/p3.key -w '%{http_code}' "http://localhost:4000$KEYURL")
check "AES key served to live session → 200" "200" "$KCODE"
check "key is exactly 16 bytes (AES-128)" "16" "$(wc -c < /tmp/p3.key | tr -d ' ')"

echo "── 5. Raw source is never exposed"
RAWCODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4000/api/v1/playback/hls/$(echo "$MASTER" | sed 's#.*/hls/##; s#/master.m3u8##')/../source/$AID.mp4")
check "traversal to raw source rejected (not 200)" "yes" "$([ "$RAWCODE" != "200" ] && echo yes || echo no)"

echo "── 6. Key denied after session ends"
curl -s -X POST $API/playback/sessions/$PSID/end -H "Authorization: Bearer $ST" > /dev/null
KCODE2=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4000$KEYURL")
check "key denied after session end → 401" "401" "$KCODE2"

echo "── 7. Expired signature rejected"
BADTOK=$(echo "$KEYURL" | sed 's#.*/key/##' | sed 's/.$/X/')
BADCODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4000/api/v1/playback/key/$BADTOK")
check "tampered token rejected (401)" "401" "$BADCODE"

echo "── 8. Access control: non-enrolled student blocked on paid lesson"
PAID=$(curl -s $API/teacher/courses/$COURSE -H "Authorization: Bearer $KH" | python3 -c 'import sys,json
d=json.load(sys.stdin)
for u in d["units"]:
  for l in u["lessons"]:
    if not l["isFreePreview"]:
      print(l["id"]); break
  else: continue
  break')
# yousef (student 5) is not enrolled in algebra
curl -s -X POST $API/auth/otp/request -H 'Content-Type: application/json' -d '{"phone":"01055555555"}' > /dev/null
YS=$(curl -s -X POST $API/auth/otp/verify -H 'Content-Type: application/json' -d '{"phone":"01055555555","code":"0000"}' | jget "['accessToken']")
BLOCK=$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/playback/sessions -H "Authorization: Bearer $YS" -H 'Content-Type: application/json' -d "{\"lessonId\":\"$PAID\"}")
check "non-enrolled student blocked on paid lesson → 403" "403" "$BLOCK"

echo "── 9. Teacher preview works (pv token) on a lesson with video"
TP=$(curl -s -X POST $API/playback/sessions -H "Authorization: Bearer $KH" -H 'Content-Type: application/json' -d "{\"lessonId\":\"$LESSON\"}")
check "teacher preview issues a ticket" "True" "$(echo "$TP" | jget "['preview']")"
TPKEY=$(echo "$TP" | jget "['keyUrl']")
check "teacher preview key served → 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:4000$TPKEY")"

echo
echo "══════════════════════════════════"
echo " Phase 3 smoke: $pass passed, $fail failed"
echo "══════════════════════════════════"
exit $fail
