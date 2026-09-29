# Error QA matrix

The failure paths worth re-checking before any release that touches them.
Each row: what to do, what the API must answer, what the reader must see, and
how they recover. The rules behind the rows are in [ERRORS.md](./ERRORS.md).

Use TEST identities and TEST academies only. In the browser, check both the
screen **and** the network response (status, `code`, no internals).

**Global expectations for every row**

- No 5xx for an expected refusal.
- The response body has `code`, `message`, `retryable`, `requestId` — and no
  stack, SQL, table/column name, file path, token or provider text.
- The sentence on screen is the copy for that code, in Arabic (and English
  after switching language) — never the API's English `message`.
- The error appears **once**: under its field, *or* in the form, *or* as a
  toast — never two of those at once.
- A modal that failed stays open, with what was typed still there.
- A Retry button appears only when `retryable` is true.
- A reference number (`رقم المرجع`) appears only for unexpected failures.

Automated coverage: `A` = `apps/api/src/common/errors/api-exception.filter.spec.ts`,
`E` = `apps/api/test/error-contract.e2e-spec.ts`,
`I` = `apps/api/src/guardian/student-care.integration.spec.ts`,
`W` = `apps/web/src/lib/errorMessage.spec.ts`.

## Guardian (Student Care)

| # | Action | Code | Status | Expected UI | Recovery | Auto |
|---|---|---|---|---|---|---|
| G1 | Add a guardian with a phone that belongs to another student/teacher account | `PHONE_IN_USE` | 409 | Under the phone field, phone focused: "رقم الموبايل ده متسجّل بالفعل لحساب تاني…"; modal stays open; no toast | Enter the guardian's own number | I W |
| G2 | Add the same guardian to the same student again | `GUARDIAN_ALREADY_LINKED` | 409 | Under the phone field: "مربوط بالطالب ده بالفعل… اضغط «رابط جديد»"; the existing link keeps working | Close, use **رابط جديد** on the row | I |
| G3 | Add a previously removed guardian | — | 201 | Link ready dialog | — | I |
| G4 | Add a guardian with the student's own phone | `GUARDIAN_IS_STUDENT` | 400 | Under the phone field | Enter the guardian's number | I |
| G5 | Phone `12345` | `INVALID_PHONE` | 400 | Under the phone field | Fix the number | I |
| G6 | Name of one letter | `VALIDATION_FAILED` → `name: TOO_SHORT {min:2}` | 400 | Under the name field ("٢ حروف على الأقل") | Fix the name | E W |
| G7 | Edit the phone after G1 | — | — | The field error clears as you type | — | — |
| G8 | Open a revoked / rotated / expired guardian link | `GUARDIAN_LINK_INVALID` | 410 | Page state: "انتهت صلاحيته أو اتلغى. اطلب رابط جديد" | Ask the academy for a new link | I |
| G9 | "رابط جديد" on a removed guardian (stale page) | `LINK_REVOKED` | 400 | Note under the list, once | Add the guardian again | — |
| G10 | Assistant opens guardians of a student outside their courses | `NOT_FOUND` | 404 | Same as a student that does not exist | — | I |

## Authentication

| # | Action | Code | Status | Expected UI | Recovery | Auto |
|---|---|---|---|---|---|---|
| A1 | Wrong password | `INVALID_CREDENTIALS` | 401 | "البيانات دي مش صح…" — **not** "session expired" | Fix and retry | W |
| A2 | Unknown email/phone | `INVALID_CREDENTIALS` | 401 | Identical to A1 (no account enumeration) | — | — |
| A3 | Too many logins | `RATE_LIMITED` | 429 | "استنى N ثانية" with the real wait | Wait | E W |
| A4 | Register with a taken phone | `PHONE_TAKEN` | 409 | Auth copy for phone taken | Sign in or use another | — |
| A6 | Wrong / expired OTP | `INVALID_CODE` / `CODE_EXPIRED` | 400 | Auth copy for that case | Re-enter / request a new code |
| A7 | Sign up with a weak password | `VALIDATION_FAILED` → `password: WEAK_PASSWORD` | 400 | Under the password field: the actual rule | Fix it |
| A5 | Expired session while using the app | `UNAUTHENTICATED` | 401 | Silent refresh; if it fails, the sign-in page — no toast | Sign in | — |

## Messaging

| # | Action | Code | Status | Expected UI | Recovery | Auto |
|---|---|---|---|---|---|---|
| M1 | Send while offline | (no response) | — | Bubble stays, marked failed, reason "تعذّر الوصول…", **Retry** + Discard | Retry when online; lands once | — |
| M2 | Send into a closed conversation | `MESSAGING_CLOSED` / `READ_ONLY` | 400/403 | Bubble failed with the reason; **no Retry**, Discard only | — | — |
| M3 | Attach a 14 MB photo | client pre-check | — | "الملف كبير جدًا (الصور حتى 10 ميجا…)" before upload | Pick a smaller file | — |
| M4 | Attach a HEIC photo | `IMAGE_HEIC` | 400 | On the file chip, full sentence (wraps, not truncated); no Retry | Convert to JPG | — |
| M5 | Attach a renamed `.exe` as `.pdf` | `FILE_CONTENT_MISMATCH` / `ATTACHMENT_TYPE` | 400 | On the chip; no Retry | Send a real file | — |
| M6 | Connection drops mid-upload | (no response) | — | On the chip: network sentence **with** Retry | Retry | — |
| M7 | Cancel an upload | canceled | — | Chip removed, nothing said | — | W |
| M8 | Daily upload quota reached | `UPLOAD_QUOTA` | 400 | "وصلت لحد الرفع اليومي (200 ميجا)" | Tomorrow | — |

## Payments / enrollment

| # | Action | Code | Status | Expected UI | Recovery |
|---|---|---|---|---|---|
| P1 | Pay from wallet with too little balance | `INSUFFICIENT_BALANCE` | 400 | Balance vs. required amounts in the modal | Top up |
| P2 | Declare a transfer with the platform's own number | `OWN_NUMBER` | 400 | Inline in the payment form: "الرقم ده بتاعنا إحنا…" | Enter the sender's number |
| P3 | Buy a course already owned | `ALREADY_ENROLLED` | 409 | Inline in the modal | Open the course |
| P5 | Apply an unknown / expired / used-up coupon | `COUPON_INVALID` / `COUPON_EXPIRED` / `COUPON_LIMIT_REACHED` | 400 | Inline, the specific reason | Check the code / pay full price |
| P4 | Two purchases of one course at once | `ALREADY_EXISTS` / handled | 409 | One succeeds; the other a clear refusal, not 500 | — |

## Live sessions

| # | Action | Code | Status | Expected UI | Recovery |
|---|---|---|---|---|---|
| L1 | Paid session with price below minimum | `LIVE_SESSION_INVALID` → `priceCents: PRICE_TOO_LOW` | 400 | Under the price field | Raise the price |
| L2 | Book a full session | `SESSION_FULL` | 400/409 | Inline: "الجلسة كاملة العدد" | — |
| L3 | Convert a class that has not ended | `CLASS_NOT_ENDED` | 409 | Inline | Wait for the end |
| L4 | Exam from a transcript that is not ready | `TRANSCRIPT_NOT_READY` | 409 | Inline | Try later |

## Exams / OCR / AI

| # | Action | Code | Status | Expected UI | Recovery |
|---|---|---|---|---|---|
| X1 | Upload a password-protected PDF | `PAPER_PDF_UNREADABLE` | 400 | "…ممكن يكون محمي بباسورد" — **no tool output or server path** in the response | Save a clean copy |
| X2 | Upload a 62 MB scan | `PAPER_FILE_TOO_LARGE` | 400 | File name, its size and the limit | Smaller scan / split |
| X3 | AI monthly budget reached | `AI_BUDGET_REACHED` | 503 | Inline, no reference number | Next month / support |
| X4 | Publish a challenge with empty questions | `CHALLENGE_INVALID` + `issues[]` | 400 | Arabic list: "سؤال ٢: نص السؤال فاضي" …; no toast | Fix each question |

## Platform

| # | Action | Code | Status | Expected UI | Auto |
|---|---|---|---|---|---|
| S1 | Any unexpected server failure | `INTERNAL_ERROR` | 500 | "حصلت مشكلة عندنا… رقم المرجع: XXXXXXXX"; the same id is in the server log | A E W |
| S2 | A Prisma constraint escapes a service | `ALREADY_EXISTS` etc. | 409 | Copy for that code; no table/column in the body | A E |
| S3 | Malformed JSON body | `MALFORMED_BODY` | 400 | JSON, not an HTML page | E |
| S4 | Body over 3 MB | `PAYLOAD_TOO_LARGE` | 413 | "الملف أكبر من الحد المسموح" | E |
| S5 | A page component crashes | — | — | That page shows "الصفحة دي مقدرتش تفتح" with Retry; the shell still works; another route works | — |
| S6 | A deploy removed a lazy chunk | — | — | One silent reload, then the page | — |
| S7 | Unknown API route | `NOT_FOUND` | 404 | — ; not logged (scanners) | A |

## Production verification — 2026-09-29 (deploy of 2c13cf5)

Unauthenticated probes. No account was created or changed; the login probe
uses an identifier that belongs to no account. Every body carried `code`,
`retryable` and a `requestId` equal to its `X-Request-Id` header, and nothing
internal.

| Probe | Before | After |
|---|---|---|
| Login, unknown account | 401 `{ message: 'Invalid credentials', error: 'Unauthorized' }` | 401 `INVALID_CREDENTIALS` |
| Sign-up, bad fields | 400 with seven English sentences | 400 `VALIDATION_FAILED` + `fields[]` with codes and `{ min: 2 }` |
| Malformed JSON | 400 "Unexpected end of JSON input" (parser text) | 400 `MALFORMED_BODY` |
| 4 MB body | 413 "request entity too large" | 413 `PAYLOAD_TOO_LARGE` |
| Protected route, no token | 401, no code | 401 `UNAUTHENTICATED` |
| Bogus guardian link | 410 `GUARDIAN_LINK_INVALID` | same, in the full envelope |
| 21 logins in one minute | — | 429 `RATE_LIMITED`, `retryAfterSeconds: 60` = `Retry-After` |

Log correlation: each probe's request id found exactly one server line, e.g.
`410 GUARDIAN_LINK_INVALID [NOT_FOUND] POST /api/v1/auth/guardian/consume`.

Screens reviewed by eye (1280 px and 360 px, Arabic and English): login with
wrong credentials, login offline, login rate-limited, sign-up field errors,
invalid guardian link. Fixed after that review: a failed password rule showed a
generic "invalid" in place of the rule (now `WEAK_PASSWORD`), "لازم يكون 2
حروف", "Wait 1 seconds", and an offline sentence that promised an automatic
retry.

## Authenticated production QA — 2026-09-29 (deploy of e3879db / 993b57f)

### TEST fixtures used

Reused, not created, unless marked. All live in TEST academies; no real
user, course or conversation was touched.

| Fixture | What | Origin |
|---|---|---|
| `darsly-smoke-teacher-65f6a4@example.com` | TEST teacher, owner of the TEST academy "SMOKE-TEST Teacher 65f6a4" (`cmuh04jou001514t4yckcf8zo`) | registered 2026-09-25 by the live-commerce smoke; credentials in that session's scratchpad, never in the repo |
| `darsly-smoke-student-65f6a4@example.com` | TEST student | same |
| "TEST · طالب اختبار 1 (smoke)" | another TEST student — used only as the *existing account* whose phone `PHONE_IN_USE` refuses | Student Care smoke |
| "TEST · ولي أمر (smoke)" | the TEST guardian — used for "already linked", link revoked again at the end | Student Care smoke |
| **created:** course `cmumlaaiw001chox2rbewt9b1` "TEST · QA أخطاء (smoke, safe to delete)" | free course with one assignment lesson; published for 1.5 s so the TEST student could enroll, then **archived** | this QA — puts the TEST student in the TEST teacher's scope (their earlier course had been deleted) |
| **created, then deleted:** one INSTAPAY payout method on the TEST academy | needed to reach the payout minimum check | this QA |

The phase-0/Student-Care TEST academy ("TEST · مدرس اختبار (smoke)") has
richer fixtures but no stored credentials, and its password reset goes to an
`@example.com` inbox, so it could not be used.

### API results — 22/22 pass

Each refusal: expected status and code, `field` where one applies, envelope
complete (`requestId` equals the `X-Request-Id` header), no internals.

| Row | Probe | Status | Code | Field |
|---|---|---|---|---|
| G0 | teacher lists guardians of own TEST student | 200 | — | — |
| G5 | invalid phone | 400 | `INVALID_PHONE` | phone |
| G6 | one-letter name | 400 | `VALIDATION_FAILED` | name: `TOO_SHORT` |
| G4 | the student's own phone | 400 | `GUARDIAN_IS_STUDENT` | phone |
| **G1** | **another account's phone — the reported conflict** | **409** | **`PHONE_IN_USE`** | **phone** |
| G3 | link the TEST guardian | 201 | — | — |
| G2 | the same guardian again | 409 | `GUARDIAN_ALREADY_LINKED` | phone |
| — | remove that link (cleanup) | 200 | — | — |
| G9 | "new link" on the removed guardian | 400 | `LINK_REVOKED` | — |
| G10 | student outside the academy | 404 | `NOT_FOUND` | — |
| G10b | student id that does not exist | 404 | `NOT_FOUND` (identical) | — |
| Z1 | a student on a staff route | 404 | `NOT_FOUND` | — |
| Z2 | a teacher naming a foreign academy | 404 | `NOT_FOUND` | — |
| Z3 | no token | 401 | `UNAUTHENTICATED` | — |
| M | empty message | 400 | `EMPTY_MESSAGE` | — |
| M4 | HEIC photo | 400 | `IMAGE_HEIC` | — |
| M5 | `.exe` renamed `.pdf` | 400 | `ATTACHMENT_TYPE` | — |
| P6 | payout below the minimum | 400 | `PAYOUT_BELOW_MINIMUM` | amountCents |
| L1 | live class with bad fields | 400 | `VALIDATION_FAILED` | startsAt |
| X5 | exam import from a `.txt` | 400 | `PAPER_FILE_TYPE` | — |
| U1 | academy logo as `.txt` | 400 | `MEDIA_TYPE` | — |

### UI results (real production screens, by eye)

- **Guardian form, reported case** (ar 1280, ar 360, en 360): the
  `PHONE_IN_USE` sentence under the phone field, phone focused, typed number
  kept, modal open, **no toast, no second note**; the error clears on edit.
  Found and fixed: the error icon was clipped beside a long message
  (`shrink-0`, 993b57f).
- **Chat, an iPhone HEIC saved as `.jpg`** (ar 360, en 1280): the chip shows
  the HEIC sentence, **no Retry** (retrying cannot help), no toast. Found and
  fixed: at the old chip width the English sentence was cut before its fix
  ("…convert it to JPG"); refused chips are now wider with four lines.

### Login lock (production, TEST teacher only)

Ten wrong passwords locked the TEST teacher. Then an unknown account, the
locked account with a wrong password, and the locked account with the
**right** password all answered `401 {"message":"Invalid credentials","code":"INVALID_CREDENTIALS","statusCode":401,"retryable":false}`
in 264 / 264 / 271 ms. The lock was visible only internally: `lockedUntil`
set in the database and `login refused: account locked user=…` in the log,
under the same request id the client received. The lock expired by itself
after 15 minutes.

### Still covered by CI rather than production

Paid purchase flows (P1–P4) and live booking (L2–L4) need a paid course or
session and real money movement; they stay covered by the Postgres
integration suites and were not exercised in production.

