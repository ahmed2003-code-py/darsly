#!/usr/bin/env bash
# Simulate the Android notification listener posting a transfer event.
# Usage: simulate-payment-event.sh <PROVIDER> <AMOUNT_EGP> [REFERENCE]
#   PROVIDER  = INSTAPAY | VODAFONE_CASH | BANK_TRANSFER | OTHER
#   AMOUNT_EGP= e.g. 450   (converted to piasters)
#   REFERENCE = optional transaction id
#
# Env: API (default http://localhost:4000/api/v1), KEY (default dev key).
set -u
API=${API:-http://localhost:4000/api/v1}
KEY=${KEY:-dev-listener-secret-123}
PROVIDER=${1:-INSTAPAY}
AMOUNT_EGP=${2:-450}
REF=${3:-}
CENTS=$(( AMOUNT_EGP * 100 ))

BODY=$(REF="$REF" PROVIDER="$PROVIDER" CENTS="$CENTS" AMOUNT_EGP="$AMOUNT_EGP" python3 - <<'PY'
import json, os
d = {
  "provider": os.environ["PROVIDER"],
  "amountCents": int(os.environ["CENTS"]),
  "rawMessage": f'استلمت {os.environ["AMOUNT_EGP"]} ج.م' + (f', رقم العملية {os.environ["REF"]}' if os.environ["REF"] else ''),
  "deviceId": "simulator",
}
if os.environ["REF"]:
    d["reference"] = os.environ["REF"]
print(json.dumps(d, ensure_ascii=False))
PY
)

echo "→ POST $API/payment-events"
echo "  $BODY"
curl -s -X POST "$API/payment-events" \
  -H 'Content-Type: application/json' \
  -H "X-Listener-Key: $KEY" \
  -d "$BODY"
echo
