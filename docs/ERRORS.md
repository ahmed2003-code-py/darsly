# How errors work in Darsly

Every failure in Darsly takes one path, from the database to the person
reading the screen. This document describes that path and the rules for
adding to it. Follow it rather than inventing error handling feature by
feature: that is how "فيه تعارض مع بيانات موجودة بالفعل" ended up in front of a
teacher whose real problem was a phone number registered to another account.

```
Prisma / services ──throw──▶ ApiExceptionFilter ──JSON──▶ axios ──▶ resolveError() ──▶ field · form note · toast · page
   (code + message)          (envelope, log, id)                   (kind, copy, retry)     (one place, never two)
```

The regression checklist is [ERRORS-QA.md](./ERRORS-QA.md).

---

## 1. The envelope

Every error response, from every route, has this shape:

```json
{
  "statusCode": 409,
  "code": "PHONE_IN_USE",
  "message": "This phone number already belongs to another Darsly account…",
  "retryable": false,
  "requestId": "0f9c2e1a-…",
  "field": "phone"
}
```

| Key | Always | Meaning |
|---|---|---|
| `code` | yes | Stable, machine-readable reason. **The web keys everything off this.** Never renamed once shipped. |
| `message` | yes | Safe English fallback for logs and API clients. **Never shown to a user** — the web has its own copy. |
| `retryable` | yes | Whether the same request, unchanged, can succeed. 5xx and 429 default to `true`, everything else to `false`. |
| `requestId` | yes | The id on the server's log line (also the `X-Request-Id` header). |
| `statusCode` | yes | The HTTP status, repeated for clients that only see the body. |
| `field` | optional | The one input a business refusal is about. |
| `fields` | optional | Validation: `[{ field, code, params? }]`, one per input. |
| `params` | optional | Numbers or names the sentence needs (`{ max: 10, mb: 14 }`). |
| `retryAfterSeconds` | 429 only | How long to wait. |

Some older refusals carry extra structured keys (`balanceCents`, `mediaIds`,
`issues`); the filter passes them through untouched.

**Why flat, not `{ error: { … } }`:** ~500 throw sites, the web resolver and
the Android payment listener already read `code`/`message` at the top level.
Nesting would have broken all of them for no gain in meaning.

Code: `apps/api/src/common/errors/` — `api-error.ts` (types, generic codes,
taxonomy), `api-exception.filter.ts` (the global filter),
`validation-exception.factory.ts` (DTO validation), `body-parser-errors.ts`
(oversized/malformed bodies, which never reach Nest). WebSocket handlers use
`realtime/ws-exception.filter.ts`, which emits the same fields on the
`exception` event.

## 2. HTTP status vs. code

They answer different questions. The **status** says what kind of failure it
is (for proxies, retries and generic clients). The **code** says which
business condition it was (for the words a person reads).

A `409` can be `PHONE_IN_USE`, `GUARDIAN_ALREADY_LINKED`, `SLUG_TAKEN` or
`VIDEO_IN_USE`. Those are four different problems with four different fixes,
and each has its own code and its own sentence.

| Status | Use for |
|---|---|
| 400 | The input is wrong and the user can fix it (`VALIDATION_FAILED`, `INVALID_PHONE`, `ATTACHMENT_TOO_LARGE`). |
| 401 | No valid session. The web refreshes the token or sends the user to sign in. |
| 403 | Signed in, but not allowed — **only when revealing that the thing exists is safe.** |
| 404 | Not found, *or* out of scope (see §7). |
| 409 | Conflicts with the current state (already linked, already taken, class not ended yet). |
| 410 | A link/token that used to work and no longer does (`GUARDIAN_LINK_INVALID`). |
| 413 / 415 | Body or file too large / unsupported type, when no domain code fits. |
| 429 | Rate limited. Always `RATE_LIMITED` + `retryAfterSeconds` from the throttler. |
| 503 | A dependency is temporarily unavailable (`AI_DISABLED`, `WRITE_CONFLICT`). |
| 500 | Only for the unexpected. Never thrown on purpose. |

Never answer an expected business refusal with a 5xx, and never answer an
error with a 200.

## 3. Taxonomy

Deliberately small. The **category** is derived from the status (see
`categoryOf` in `api-error.ts`) and appears in every log line; it tells you who
has to act. The **code** tells you what exactly.

| Category | Who acts | Examples |
|---|---|---|
| `VALIDATION` | the user, on a field | `VALIDATION_FAILED` + field codes |
| `AUTHENTICATION` | the user, by signing in | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED` |
| `AUTHORIZATION` | an admin, by granting | `FORBIDDEN`, `NO_MESSAGE_PERMISSION`, `ANALYTICS_OWNER_ONLY` |
| `NOT_FOUND` | nobody / the user navigates | `NOT_FOUND`, `GUARDIAN_LINK_INVALID` |
| `CONFLICT` | the user, by choosing differently | `PHONE_IN_USE`, `GUARDIAN_ALREADY_LINKED`, `ALREADY_ENROLLED` |
| `RATE_LIMIT` | the user, by waiting | `RATE_LIMITED`, `TOO_MANY_ATTEMPTS` |
| `BUSINESS_RULE` | the user, by doing something else first | `CLASS_NOT_ENDED`, `PAYMENT_REQUIRED` |
| `TEMPORARY_FAILURE` | nobody — retry later | `WRITE_CONFLICT`, `AI_DISABLED`, `LIVE_PROVIDER_UNREACHABLE` |
| `INTERNAL` | engineering | `INTERNAL_ERROR` |

**Generic codes** — `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `GONE`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`,
`UNPROCESSABLE`, `RATE_LIMITED`, `INTERNAL_ERROR`, `UPSTREAM_ERROR`,
`SERVICE_UNAVAILABLE`, `UPSTREAM_TIMEOUT` — are what the filter assigns to a
refusal thrown *without* a code. The web answers them with its per-status
sentence. They are a floor, not a goal: a refusal a person can meet should
have its own code.

## 4. Adding a new domain error

1. **Throw it with a code** at the place that knows what it means:

   ```ts
   throw new ConflictException({
     code: 'GUARDIAN_ALREADY_LINKED',
     message: 'This guardian is already linked to this student',
     field: 'phone',
   });
   ```

   Pick the status from §2. Add `field` if exactly one input is wrong,
   `params` if the sentence needs a number. Never put ids, storage keys,
   tokens, SQL, or a library's own error text in `message` or `params`.

2. **Write the copy** in `apps/web/src/i18n/ar.json` **and** `en.json`, under
   `err`, at the derived key: `GUARDIAN_ALREADY_LINKED` → `err.eGuardianAlreadyLinked`.
   The sentence says what happened, why, and what to do now:

   > ولي الأمر ده مربوط بالطالب ده بالفعل. لو محتاج يدخل تاني، اضغط «رابط جديد» جنب اسمه في القائمة.

   Use `{{param}}` for values from `params`. Arabic is Egyptian and natural;
   English is plain and professional. Don't say "try again" when trying again
   cannot help.

3. **Run `npm run check:errors`.** It fails on any code the API throws that has
   no copy in both languages, unless the web handles it itself or it is on the
   script's allowlist with a reason. CI runs it on every push.

4. **Test it** (§9).

That is all. There is no exception class per error and no registry to edit;
the code string is the contract.

### Database errors

Translate Prisma errors **at the service**, where the meaning is known. A
P2002 in `guardians.add` means "two staff added the same parent at the same
moment", and the right answer there is to retry and link, not a 409. The
filter's own Prisma mapping (`P2002 → ALREADY_EXISTS`, `P2003 →
RELATED_RECORD_CONFLICT`, `P2025 → NOT_FOUND`, `P2034 → WRITE_CONFLICT`) is a
last-resort safety net that guarantees no table or column name ever reaches a
client. Unknown Prisma codes stay 500s.

## 5. Validation

The global `ValidationPipe` uses `validationExceptionFactory`, so a bad DTO
answers:

```json
{ "code": "VALIDATION_FAILED", "fields": [{ "field": "phone", "code": "INVALID_PHONE" },
                                          { "field": "name", "code": "TOO_SHORT", "params": { "min": 2 } }] }
```

Field codes: `REQUIRED`, `TOO_LONG`, `TOO_SHORT`, `INVALID_EMAIL`,
`INVALID_PHONE`, `TOO_SMALL`, `TOO_LARGE`, `NOT_A_NUMBER`, `INVALID_CHOICE`,
`INVALID_DATE`, `INVALID_URL`, `TOO_MANY`, `TOO_FEW`, `UNKNOWN_FIELD`,
`INVALID`. Their copy lives under `err.field.*`. class-validator's own
sentences are never sent. A `@Matches` on a property named like a phone is
reported as `INVALID_PHONE`.

A service can return the same shape for its own checks (the live-session form
does: `LIVE_SESSION_INVALID` + `fields` with domain codes such as
`PRICE_TOO_LOW`) — the web resolves a field code from `err.field.*` first,
then from the domain `err.e*` copy.

## 6. The web: one interpreter

`apps/web/src/lib/errorMessage.ts` is the only place that interprets a
failure. Components never read `response.status`, `response.data.message` or
`error.message` to decide what to show.

```ts
const r = resolveError(error);
r.message            // localized sentence, ready to show ('' = show nothing)
r.kind               // canceled | offline | network | timeout | unauthenticated | forbidden
                     // | notFound | rateLimited | validation | refused | server | client
r.retryable          // show a Retry button only when this is true
r.code, r.field, r.requestId, r.retryAfterSeconds

fieldErrors(error)                 // { phone: { message, code, params } }
splitFormError(error, ['name', 'phone'])   // { fields: { phone: '…' }, rest: null }
```

What it guarantees:

- **The API's English never reaches the screen.** A code with no copy falls
  back to a per-status sentence, then to a generic one.
- A cancelled request says nothing. A timeout, an offline device and an
  unreachable server each have their own sentence. An exception thrown by our
  own code is never blamed on the network.
- A 429 says how long to wait.
- An **unexpected** failure (a 5xx the API did not name) ends with
  `رقم المرجع: AB12CD34` — the first 8 characters of the request id — so
  support can find the log line. Ordinary refusals never carry one.

Sign-in screens use `authErrorText` (`lib/authError.ts`), which keeps its own
account-state copy and otherwise delegates to the resolver.

## 7. Where an error is shown — and only once

| Error | Show it | How |
|---|---|---|
| About one input | Under that input, focus it | `splitFormError` → `<Field error=…>` |
| About the form as a whole | Inside the form, near the action | `<ErrorNote error={e} fields={FORM_FIELDS} />` |
| From a row action / background save | Toast | automatic (MutationCache) |
| A page's data cannot load | The page itself | `<ErrorNote>` / an empty state; 5xx and network also toast |
| Not allowed / not found | The page itself | page state, never a toast |
| Rendering bug | The section | `SectionErrorBoundary` (per route, inside the shell) |

**Never twice.** Every failed mutation is toasted by the query client — the
safety net for actions with nowhere else to speak. When a component renders
the same error inline, `<ErrorNote>` (or `claimError()`) *claims* it, and the
toast, which waits `TOAST_CLAIM_WINDOW_MS`, is skipped
(`lib/errorPresentation.ts`). So: render the error inline where there is a
place for it, and do nothing else. `meta: { silentError: true }` remains for
mutations that report their failure some other way (a custom list, a failed
chat bubble).

**Modals stay open on failure** and keep what the user typed. Use
`mutateAsync(...).catch(() => …)` or `mutate` — never let a rejected
`mutateAsync` close the dialog. Clear a field's error when the user edits it
(`mutation.reset()`).

**Retry only when it can work** — `resolved.retryable`. The chat composer is
the reference: a message rejected because the conversation is closed shows
why and offers Discard only; a message lost to the network offers Retry, and
the `clientMessageId` makes a retry land exactly once.

## 8. Security: what is deliberately vague

Specificity is good until it discloses something. These stay vague on purpose:

- **Out-of-scope resources are 404, not 403.** An assistant asking for a
  student outside their courses gets the same `NOT_FOUND` as for an id that
  does not exist (`StaffScopeService.assertStudent`). The filter never turns a
  404 into anything else.
- **Login** answers `INVALID_CREDENTIALS` for an unknown account and for a
  wrong password alike, with equal latency.
- **`PHONE_IN_USE`** says the number belongs to "another Darsly account", not
  which kind — staff must not be able to probe whether a number is a teacher.
- **Guardian and invitation links** answer "expired or cancelled" without
  saying which.
- **Unexpected errors** carry `INTERNAL_ERROR` and a request id — never a
  stack, a driver message, a table or column, a file path or a provider's
  error text. The PDF reader's tool output, for instance, goes to the log
  only.

## 9. Logging

The filter writes exactly one line per error response, with the route
**template** (never the raw path, which can hold ids or tokens), the user id,
the academy header, the code and the category:

```
409 PHONE_IN_USE [CONFLICT] POST /api/v1/staff/students/:studentId/guardians user=… academy=…
500 INTERNAL_ERROR [INTERNAL] GET /api/v1/… user=… — TypeError: … (+ stack)
```

- Refusals (4xx) are `log` level; 429 is `warn`; unexpected failures are
  `error` with the stack. 401s and 404s on unmatched paths are not logged
  (token expiry and scanners).
- In production every line is JSON with `requestId`, so the reference a user
  reads out finds the line directly.
- Never log request bodies, passwords, tokens, guardian link secrets or API
  keys. The filter does not.
- Background jobs (video, AI, recording, paper import) keep their raw failure
  text in their own `error` column for engineering and show users a fixed,
  localized state instead.

## 10. Testing requirements

For a new domain error, at least:

- **Backend:** the status and `code` (`rejects.toMatchObject({ status, response: { code, field } })`),
  and for anything touching the database, an integration test against real
  Postgres (they run in CI).
- **Copy:** `npm run check:errors` passes.
- **Web:** if the error has special presentation, a case in
  `apps/web/src/lib/errorMessage.spec.ts` or the feature's own spec.
- **Security:** if it is an authorization refusal, a test that an
  out-of-scope caller cannot tell it apart from a missing resource.

The contract itself is covered by `common/errors/api-exception.filter.spec.ts`
(unit) and `test/error-contract.e2e-spec.ts` (over real HTTP).
