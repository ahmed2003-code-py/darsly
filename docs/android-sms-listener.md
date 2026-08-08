# Automatic payment verification — Android SMS listener

Darsly verifies Vodafone Cash / InstaPay / bank (CIB) transfers **without a
payment gateway**. A small Android app on the phone that owns the receiving
wallet/account **monitors incoming SMS** (with the user's explicit `RECEIVE_SMS`
permission), classifies payment-relevant senders, and posts a structured event
to the backend, which matches it to a pending payment and auto-activates the
enrollment.

```
Bank / Wallet → sends transfer SMS → the receiving phone
                          │  BroadcastReceiver (RECEIVE_SMS, user-granted)
                          ▼
             Room (local, source of truth)  →  WorkManager outbox (retry/backoff)
                          │  device JWT (OTP-verified)
                          ▼
        POST /api/v1/device/sms-events   →   PaymentMatchingService
                          ├── single confident match → verify → subscription ACTIVE
                          └── none / several / no reference → stored for manual review
```

This **supersedes** the old `NotificationListenerService`
([android-payment-listener.md](./android-payment-listener.md)). It uses **only
official, user-authorized Android APIs** — no notification scraping, no
accessibility abuse, no permission bypass.

---

## Compliance note — distribution

`RECEIVE_SMS`/`READ_SMS` are **restricted permissions** under Google Play's
[SMS & Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820).
An SMS-forwarding utility does **not** qualify for public Play distribution
(only default SMS handlers / narrow exceptions do). This app is therefore
intended for **private / internal distribution** — direct APK install or MDM to
the receiving phone(s) only. It is fully compliant with Android's **security**
model (real runtime permission prompt, no bypass); it is simply not a public
Play Store app. The user must explicitly grant SMS access.

---

## Device API contract

Base URL: `/api/v1`. All device routes live under `/device`. Auth is a
**device-scoped JWT** (claim `typ: "device"`), obtained via OTP and stored in the
Android Keystore. This is independent of the marketplace user/session model.

### Auth / registration

| Method & path | Auth | Body → Response |
|---|---|---|
| `POST /device/auth/request-otp` | public, 5/min | `{ phone }` → `{ expiresInSeconds }` |
| `POST /device/auth/verify-otp` | public, 10/min | `{ phone, code, model?, appVersion? }` → `{ accessToken, refreshToken, deviceId, phone }` |
| `POST /device/auth/refresh` | public | `{ refreshToken }` → `{ accessToken, refreshToken, deviceId }` |

- OTP reuses the platform `OtpService` (argon2-hashed codes, TTL + attempt cap).
  In dev (`OTP_DEV_MODE=true`, non-prod only) codes are logged and `0000` is
  accepted.
- `phone` accepts any Egyptian format; it is normalized to E.164 (`+2010…`).
  The client-supplied phone is **never trusted** without a consumed OTP.
- Refresh tokens rotate on every use; presenting a rotated-away token is treated
  as reuse → the device is revoked (stored refresh hash is argon2, per device).

### Authenticated device routes (Bearer device JWT)

| Method & path | Purpose |
|---|---|
| `GET /device/me` | device + verified phone status |
| `POST /device/heartbeat` | liveness; updates `lastSeen`, returns server time |
| `POST /device/unregister` | secure logout — revoke this device |
| `GET /device/sms-rules` | backend-driven sender classification rules |
| `POST /device/sms-events` | ingest a received SMS (idempotent) — 120/min |

### `GET /device/sms-rules`

Returns the enabled rules the app applies locally (priority ascending, lower
wins). Business logic is **not** hard-coded in the APK — it is editable in the DB
(`sender_rules`) and seeded with sensible defaults (CIB, Vodafone Cash, InstaPay)
on first boot.

```jsonc
[
  { "brand": "CIB",           "matchType": "CONTAINS", "pattern": "cib",      "provider": "BANK_TRANSFER",  "enabled": true, "forwardToBackend": true, "priority": 10 },
  { "brand": "Vodafone Cash", "matchType": "CONTAINS", "pattern": "vodafone", "provider": "VODAFONE_CASH", "enabled": true, "forwardToBackend": true, "priority": 20 },
  { "brand": "InstaPay",      "matchType": "CONTAINS", "pattern": "instapay", "provider": "INSTAPAY",      "enabled": true, "forwardToBackend": true, "priority": 30 }
]
```

`matchType` is `EXACT | CONTAINS | REGEX`, matched case-insensitively against the
normalized sender id — because SMS sender IDs (`CIB`, `VodafoneCash`, short
codes) rarely equal the displayed brand exactly.

### `POST /device/sms-events`

```jsonc
{
  "sender": "CIB",
  "message": "Your account was credited with EGP 5,000. Ref 884213",
  "receivedAt": "2026-08-08T06:12:00Z",
  "messageHash": "<sha256 hex, ≥16 chars>",     // dedupe id (see below)
  "simSlot": 1,                                  // optional (dual-SIM)
  "subscriptionId": 3                            // optional (dual-SIM)
}
```

Response:

```jsonc
{
  "eventId": "…", "duplicate": false, "forwarded": true,
  "brand": "CIB", "provider": "BANK_TRANSFER",
  "amountCents": 500000, "reference": "884213",
  "status": "MATCHED"   // MATCHED | UNMATCHED | AMBIGUOUS | DUPLICATE | LOCAL_ONLY
}
```

Behavior:

- The backend **re-derives** provider/amount/reference from `message`
  (server-authoritative — never trusts the client for money-affecting fields),
  then forwards into the shared `PaymentMatchingService` (same engine, same
  ledger/enrolment activation as the legacy path).
- Unknown / non-forwardable senders are recorded `LOCAL_ONLY` and never
  forwarded.
- **Idempotency (two layers):**
  1. `UNIQUE(deviceId, messageHash)` on `device_sms_events` — a re-POST returns
     `duplicate: true` and never double-forwards. A prior event that was recorded
     but not yet forwarded (e.g. a transient failure) **self-heals** on retry.
  2. `PaymentMatchingService` dedupes on `provider:normalizedReference:amount`
     (unique), so even the legacy path can't double-credit.

`messageHash = SHA-256(normalizedSender + " " + body + " " + receivedAtEpochSec)`.
The app computes the same hash locally to dedupe its outbox before sending.

---

## Testing without a phone

The legacy `X-Listener-Key` endpoint remains for quick simulation:

```bash
scripts/simulate-payment-event.sh VODAFONE_CASH 450 TXN-DEMO-8842
```

Or exercise the full device flow (dev OTP `0000`):

```bash
API=http://localhost:4000/api/v1
TOK=$(curl -s -XPOST $API/device/auth/verify-otp -H 'Content-Type: application/json' \
  -d '{"phone":"01012345678","code":"0000"}' | jq -r .accessToken)
HASH=$(printf 'demo body' | sha256sum | cut -d' ' -f1)
curl -s -XPOST $API/device/sms-events -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d "{\"sender\":\"CIB\",\"message\":\"credited EGP 5,000 Ref 884213\",\"receivedAt\":\"2026-08-08T06:12:00Z\",\"messageHash\":\"$HASH\"}"
```

---

## The Android app

The client lives in [`android/`](../android) — Kotlin, Jetpack Compose, MVVM with a
Room-backed outbox and WorkManager sync. See
[`android/README.md`](../android/README.md) for architecture, build configuration,
the security model, and the test matrix.

The shape of it:

```
SMS_RECEIVED (manifest receiver, fires with the app closed)
   → SmsExtractor → SmsRepository → Room  [LOCAL_ONLY | PENDING]
   → WorkManager (network constraint + exponential backoff)
   → POST /device/sms-events → Room [SYNCED | FAILED]
```

The phone classifies locally only to decide **what to queue**; the server
re-derives provider, amount and reference from the raw body, so a stale local rule
can never move money. Duplicate protection is enforced on both sides from the same
hash — the outbox primary key on the device, `UNIQUE(deviceId, messageHash)` on the
server.

Build it against a backend with:

```bash
cd android
./gradlew assembleRelease -PdarslyApiBaseUrl=https://api.your-domain.com/api/v1/
```

There is **no shared secret in the APK** — unlike the legacy `X-Listener-Key`
path, the app authenticates with a device JWT it earns at runtime via OTP.

## Data model (added)

- `listener_devices` — OTP-registered devices (phone, model, refresh-hash,
  revoked state).
- `sender_rules` — backend-driven classification (brand, matchType, pattern,
  provider, enabled, forwardToBackend, priority).
- `device_sms_events` — server mirror of the device outbox; `UNIQUE(deviceId,
  messageHash)`; links to the resulting `payment_events` row when forwarded.

## Logging

Never log full SMS bodies, OTP codes, or tokens. The ingestion log records only
the event id and match status (`SMS event <id> forwarded → <STATUS>`).
