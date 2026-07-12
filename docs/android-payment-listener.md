# Automatic payment verification — Android notification listener

Darsly verifies Vodafone Cash / InstaPay transfers **without a payment gateway**.
A tiny Android app runs on the phone that owns the receiving wallet, reads the
incoming-transfer notifications, and posts a structured **payment event** to the
backend, which matches it to a pending payment and auto-activates the enrolment.

```
Student → transfers money → Vodafone Cash / InstaPay
                                   │  (notification on the receiving phone)
                                   ▼
                    Android NotificationListenerService
                                   │  parse amount + reference
                                   ▼
             POST /api/v1/payment-events   (X-Listener-Key: <secret>)
                                   ▼
                     Backend matching engine
                     ├── single confident match → verify → subscription ACTIVE
                     └── none / several          → stored for manual review
```

The uploaded **screenshot is only a fallback** for disputes / manual review;
most payments verify automatically.

## Backend contract

`POST /api/v1/payment-events` — **public**, authenticated by a shared secret in
the `X-Listener-Key` header (env `PAYMENT_LISTENER_KEY`). Rate-limited.

```jsonc
{
  "provider": "INSTAPAY",        // INSTAPAY | VODAFONE_CASH | BANK_TRANSFER | OTHER
  "amountCents": 45000,          // integer piasters (EGP × 100)
  "reference": "TXN-DEMO-8842",  // transaction id parsed from the notification
  "occurredAt": "2026-07-12T14:21:00Z", // optional; defaults to now
  "rawMessage": "استلمت 450 ج.م …",     // optional; kept for audit
  "deviceId": "pixel-01"                 // optional
}
```

Response: `{ "eventId", "status", "matchedPaymentId" }` where `status` is
`MATCHED | UNMATCHED | AMBIGUOUS | DUPLICATE`.

### Matching rules (server, `PaymentMatchingService`)

- **Candidates**: `PENDING` manual payments with the **same amount** and
  **same method/provider**, created within a time window
  (−72 h … +30 min around the transfer).
- **Disambiguate by reference**: the student enters their transfer reference at
  checkout; the listener extracts it from the notification. References match on
  equality or containment (normalised to digits/letters).
  - exactly one reference match → **MATCHED** (auto-verify)
  - no reference match but exactly one amount candidate → **MATCHED**
  - several candidates, none uniquely referenced → **AMBIGUOUS** (manual)
  - no candidates → **UNMATCHED** (manual)
- **De-dupe**: a reference already matched → **DUPLICATE** (never double-credits).

`MATCHED` runs the same verification as a human: books the balanced ledger
transaction + invoice, flips the enrolment to `ACTIVE`, and notifies the student
("auto-confirmed"). Admin reviews `UNMATCHED`/`AMBIGUOUS` at `/admin/payments`.

## Android app

Minimal single-purpose app. Only needs **Notification Access** (no internet-facing
surface beyond the outbound POST). Ship it only to the receiving phone.

### Manifest

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>

<service
    android:name=".PaymentNotificationListener"
    android:label="Darsly Payment Listener"
    android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"
    android:exported="false">
  <intent-filter>
    <action android:name="android.service.notification.NotificationListenerService"/>
  </intent-filter>
</service>
```

Grant access once: **Settings → Apps → Special access → Notification access →
Darsly Payment Listener → Allow**. (Or deep-link to
`Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`.)

### Listener service (Kotlin skeleton)

```kotlin
class PaymentNotificationListener : NotificationListenerService() {

    // Package names of the wallet apps (verify on the target device).
    private val watched = setOf(
        "com.vodafone.egypt.myvodafone",   // Vodafone Cash (My Vodafone)
        "com.instapay.instapay",           // InstaPay
    )
    private val backend = "https://YOUR_DOMAIN/api/v1/payment-events"
    private val listenerKey = BuildConfig.LISTENER_KEY   // injected, not hard-coded

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName
        if (pkg !in watched) return

        val extras = sbn.notification.extras
        val text = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
            extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
        ).joinToString(" ")

        val amountCents = parseAmountCents(text) ?: return   // ignore non-payment notifs
        val provider = if (pkg.contains("vodafone")) "VODAFONE_CASH" else "INSTAPAY"
        val reference = parseReference(text)

        postEvent(provider, amountCents, reference, text, sbn.postTime)
    }

    // "استلمت 450 ج.م" / "received EGP 450.00" → 45000
    private fun parseAmountCents(t: String): Int? {
        val m = Regex("""(\d[\d,]*\.?\d{0,2})\s*(?:ج\.?م|EGP|جنيه)""").find(t) ?: return null
        val v = m.groupValues[1].replace(",", "").toDoubleOrNull() ?: return null
        return Math.round(v * 100).toInt()
    }

    // Transaction / reference number (6+ digits), best-effort.
    private fun parseReference(t: String): String? =
        Regex("""(?:رقم العملية|reference|ref|txn|رقم مرجعي)[:\s#]*([A-Za-z0-9\-]{4,})""",
              RegexOption.IGNORE_CASE).find(t)?.groupValues?.get(1)
            ?: Regex("""\b(\d{6,})\b""").find(t)?.groupValues?.get(1)

    private fun postEvent(provider: String, cents: Int, ref: String?, raw: String, ts: Long) {
        val body = JSONObject().apply {
            put("provider", provider); put("amountCents", cents)
            ref?.let { put("reference", it) }
            put("occurredAt", java.time.Instant.ofEpochMilli(ts).toString())
            put("rawMessage", raw); put("deviceId", Build.MODEL)
        }.toString()

        // Use OkHttp/WorkManager with retry+backoff in production.
        val req = Request.Builder().url(backend)
            .header("X-Listener-Key", listenerKey)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        OkHttpClient().newCall(req).enqueue(object : Callback {
            override fun onFailure(c: Call, e: IOException) { /* WorkManager retry */ }
            override fun onResponse(c: Call, r: Response) { r.close() }
        })
    }
}
```

**Production hardening**: queue events with `WorkManager` (retry on no-network),
keep `LISTENER_KEY` out of source (Gradle property / encrypted), pin the domain,
and de-dupe locally on `(postTime, text)` before sending.

## Testing without a phone

Simulate the listener with `scripts/simulate-payment-event.sh` (or curl):

```bash
curl -X POST http://localhost:4000/api/v1/payment-events \
  -H 'Content-Type: application/json' \
  -H 'X-Listener-Key: dev-listener-secret-123' \
  -d '{"provider":"INSTAPAY","amountCents":45000,"reference":"TXN-DEMO-8842","rawMessage":"استلمت 450 ج.م، رقم العملية TXN-DEMO-8842"}'
```

## Future: official gateway

When volume justifies the fees, drop the listener and point a **Paymob/Fawry**
webhook at `/api/v1/payment-events` (or a gateway-specific handler) — the rest of
the system (ledger, enrolment activation, admin review) is unchanged.
