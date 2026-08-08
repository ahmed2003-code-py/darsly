# Darsly SMS Listener — Android app

A small, single-purpose Android client that monitors **incoming SMS on the phone
whose owner installed and authorized it**, and forwards payment-relevant messages
to the Darsly backend so transfers can be verified without a payment gateway.

It is the successor to the notification-listener prototype in
[`docs/android-payment-listener.md`](../docs/android-payment-listener.md). The API
contract it speaks is documented in
[`docs/android-sms-listener.md`](../docs/android-sms-listener.md); the server side
lives in [`apps/api/src/device/`](../apps/api/src/device).

---

## Scope and boundaries

This app uses **only official, user-granted Android APIs**:

- A manifest-declared `BroadcastReceiver` for `SMS_RECEIVED`, behind the standard
  runtime `RECEIVE_SMS` permission prompt.
- No `NotificationListenerService`, no `AccessibilityService`, no hidden or
  stealth behaviour, no attempt to work around a denied permission.
- No foreground service kept alive artificially, and no battery-optimization
  exemption prompt. `SMS_RECEIVED` already wakes the app; nothing else is needed.

`READ_SMS` is deliberately **not** requested — the app never reads existing
message history, only messages that arrive while it is installed and permitted.

> ### Distribution: private only
>
> `RECEIVE_SMS` and `READ_SMS` are **restricted permissions** under Google Play's
> [SMS and Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820).
> Only apps whose core functionality requires it — principally the user's default
> SMS handler — qualify. An SMS-forwarding utility does not, so **this app cannot
> be published on the public Play Store** and would be rejected if submitted.
>
> It is built for **private distribution**: direct APK install, or MDM/EMM managed
> distribution, to the specific handset that owns the receiving wallet/bank
> account. It remains fully compliant with Android's *security* model — the
> permission is real, requested normally, and refusable.

---

## Architecture

MVVM with a thin repository layer. Room is the source of truth; the network is
never on the receive path.

```
 SMS_RECEIVED broadcast
        │  (manifest receiver — fires with the app closed)
        ▼
   SmsExtractor ──► SmsRepository ──► Room  (outbox: LOCAL_ONLY | PENDING)
                          │                         │
                    classify via                    │  WorkManager
                    SenderClassifier                ▼  (network constraint,
                    + cached backend rules      SyncWorker    exponential backoff)
                                                    │
                                                    ▼
                             POST /device/sms-events (device JWT)
                                                    │
                                                    ▼
                                          Room: SYNCED / FAILED
```

```
app/src/main/java/com/darsly/smslistener/
├── domain/        pure logic — classification, hashing, retry policy, phone rules
├── data/
│   ├── local/     Room entities, DAOs, database
│   ├── remote/    Retrofit API, DTOs, OkHttp auth + token refresh
│   ├── security/  Keystore-backed session store, user settings
│   └── repo/      SmsRepository (outbox), DeviceRepository (registration)
├── sms/           BroadcastReceiver, PDU extraction, dual-SIM slot resolution
├── work/          SyncWorker, MaintenanceWorker, WorkScheduler
├── notify/        payment-SMS notifications
├── ui/            Compose screens + ViewModels (verify → permission → inbox)
└── di/            ServiceLocator (manual DI — no framework)
```

Dependencies are kept to the minimum the brief allows: Compose, Room, Retrofit +
OkHttp + kotlinx.serialization, WorkManager, androidx.security-crypto. No DI
framework, no image loader, no navigation library (three screens are routed from
state).

---

## User flow

1. **Verify** — enter phone number → backend sends an OTP → enter the code. The
   phone number is only a claim until the backend confirms its own OTP; the device
   is registered and issued a device-scoped JWT at that moment.
2. **Permission** — a plain explanation of why SMS access is needed, then the
   standard Android prompt. If it is permanently denied, the app explains that and
   offers a shortcut to the system settings page. It does not work around it.
3. **Inbox** — sender, one-line preview, timestamp, sync status
   (`Synced` / `Pending` / `Local only` / `Failed`).
4. **Settings** — verified number, permission status, backend connection, pending
   count, manual sync, notification-preview toggle, delete local messages,
   disconnect device.

---

## Reliability: the outbox

Every incoming SMS is written to Room **before** anything else happens. That is
what makes the guarantees hold:

| Situation | Behaviour |
|---|---|
| No connectivity | Stored `PENDING`; WorkManager waits for a network. |
| Backend down / 5xx | Stays `PENDING`, retried with exponential backoff. |
| Access token expired | Refreshed transparently, request replayed once. |
| Refresh fails on the network | Session **kept**; retried later. |
| Refresh rejected (401/403) | Device was revoked → session cleared, back to verify. |
| Rejected payload (4xx) | Parked `FAILED`, still stored and visible; "Sync now" revives it. |
| Broadcast delivered twice | Second insert hits the hash primary key and is a no-op. |
| Response lost after a successful POST | Retry returns `duplicate: true` → counted as synced. |
| Phone rebooted | WorkManager restores the periodic drain; nothing is lost. |

**Duplicate protection is two-layered and neither side trusts the other:**

```
messageHash = SHA-256(normalizedSender + " " + body + " " + receivedAtEpochSeconds)
```

- On the phone it is the **primary key** of the outbox table.
- On the server it is `UNIQUE(deviceId, messageHash)`, and
  `PaymentMatchingService` additionally dedupes on provider/reference/amount.

`MessageHasherTest` pins the exact formula so the two implementations cannot drift
apart silently.

---

## Sender rules

Classification is **not** hard-coded. `GET /device/sms-rules` returns the rule set
and it is cached locally, replaced atomically on each refresh:

```jsonc
{ "brand": "CIB", "matchType": "CONTAINS", "pattern": "cib",
  "provider": "BANK_TRANSFER", "enabled": true, "forwardToBackend": true, "priority": 10 }
```

`matchType` is `EXACT | CONTAINS | REGEX`, matched case-insensitively against a
normalized sender id — because real sender ids (`CIB-Bank`, `VodafoneCash`, short
codes) rarely equal the display brand. Lower `priority` wins. Unknown senders stay
`LOCAL_ONLY` and are never uploaded.

The only rules in the APK are a small **bootstrap** set (`BootstrapRules`), used
until the first successful rules sync so a payment SMS arriving minutes after
install is not misfiled. The backend replaces it wholesale.

Note that the phone's verdict only decides *what gets queued*. The server
re-derives provider, amount and reference from the raw body before anything can
auto-verify a payment, so a stale local rule can never move money.

---

## Security

- **HTTPS only.** `network_security_config.xml` forbids cleartext; a debug-only
  overlay permits it for `10.0.2.2`/localhost. Release builds **fail** if the
  configured base URL is not `https://`.
- **Standard certificate validation** via the platform trust store. No custom
  `TrustManager`. Pinning is deliberately omitted — a certificate rotation would
  otherwise silently stop payment events from being delivered.
- **No secrets in the APK.** There is no API key or shared listener secret. The
  app's only credential is a device JWT earned at runtime by proving control of
  the phone number, and stored in `EncryptedSharedPreferences` under an
  AES-256-GCM Android Keystore key — never plain `SharedPreferences`.
- **Refresh-token rotation** with server-side reuse detection: presenting a
  rotated-away refresh token revokes the device.
- **Revocation** from either end — `POST /device/unregister` from the app, or
  server-side revocation which invalidates the next token refresh.
- **Local data.** App-private storage, `allowBackup=false`, and cloud
  backup/device-transfer excluded, so an authorized device's messages and tokens
  do not follow the user to a new phone. Full at-rest encryption (SQLCipher) is
  not used: it is a heavy native dependency, and the realistic threat — a lost
  unlocked phone — is better answered by device encryption plus remote revocation.
- **Input validation** client-side as a courtesy; the backend re-validates
  everything and is authoritative.
- **Rate limiting** is enforced by the backend: 5/min on OTP request, 10/min on
  verify, 120/min on SMS events. The app treats 429 as retryable and backs off.

### Logging strategy

| Level | What is logged | Where |
|---|---|---|
| `Log.w` | Failure *class* only (e.g. `SocketTimeoutException`), sender id | receiver, sync worker |
| — | **Never**: message bodies, OTP codes, access/refresh tokens, amounts, references | anywhere |

Release builds additionally strip every `android.util.Log` call via ProGuard, so
a shipped APK cannot leak message content into a bug report. Backend-side, the
ingestion log records only the event id and match status.

---

## Building

Requires the Android SDK (API 34) and JDK 17. `minSdk` is 26.

```bash
cd android

# Point the app at your backend (trailing slash required).
./gradlew assembleDebug   -PdarslyApiBaseUrlDebug=http://10.0.2.2:4000/api/v1/
./gradlew assembleRelease -PdarslyApiBaseUrl=https://api.your-domain.com/api/v1/
```

Prefer putting the URL in `~/.gradle/gradle.properties` rather than passing it
each time. Defaults live in [`gradle.properties`](gradle.properties).

The Gradle **wrapper JAR is not checked in**. Generate it once with a local Gradle
8.7 (`gradle wrapper`), or just open the `android/` folder in Android Studio,
which does it for you.

### Tests

```bash
./gradlew test                  # JVM unit tests
./gradlew connectedAndroidTest  # instrumented — needs a device/emulator
```

| Suite | Covers |
|---|---|
| `SenderClassifierTest` | classification, priority, regex, unknown senders, malformed patterns |
| `MessageHasherTest` | determinism, normalization, and the exact backend formula |
| `SmsExtractorTest` | multipart reassembly, dual-SIM metadata, empty broadcasts |
| `SyncPolicyTest` | retry vs. permanent failure vs. auth failure |
| `PhoneNumbersTest` | Egyptian number formats |
| `OtpFlowTest` | request → verify → registered, and every failure state |
| `SmsOutboxTest` | queueing, duplicates, offline, 5xx, 4xx, rules refresh |
| `TokenRefreshTest` | transparent refresh, revocation, and *not* dropping a session on a blip |
| `SmsSyncIntegrationTest` (instrumented) | the same guarantees against a real Room database |

---

## Manual verification

With the API running locally (`npm run dev:api`) and `OTP_DEV_MODE=true`, the dev
OTP is `0000`. The full device flow can also be exercised without a phone:

```bash
bash ../scripts/smoke-device-sms.sh
```

On a real handset, send yourself an SMS from a sender id containing `CIB` and
watch it move `Pending → Synced` in the inbox.
