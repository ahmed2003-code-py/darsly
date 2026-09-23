# Paper exam import

A teacher photographs an exam they already have on paper, checks what came
off it, and confirms. What they confirm is an ordinary Darsly `Quiz` on an
ordinary QUIZ `Lesson` — the student side, the grading, the gating, the
certificates and the leaderboards know nothing about paper.

This is an **authoring pipeline into the existing exam model**, not a second
exam engine. Everything below exists to get a paper into that model cheaply
and honestly; nothing below changes what an exam is once it is there.

---

## The pipeline

```
upload  ──▶ validate ──▶ store ──▶ prepare ──▶ read ──▶ validate ──▶ review ──▶ confirm
 (HTTP)      (MIME +     (original   (rotate,   (AI,     (deterministic)  (teacher)   (Quiz +
             magic +      kept)      grey,      per                                    Lesson)
             size +                  resize /   page)
             page count)             pdftotext)
```

Each stage is a separate place in the code and, for the last four, a separate
row you can look at:

| Stage | Where | Observable as |
|---|---|---|
| upload, validation, storage | `PaperImportService.create` | `PaperImport.status`, `PaperImportPage` rows |
| preparation | `PagePreparerService` | `PaperImportPage.renderKey` / `.textKey` |
| reading | `PaperImportHandler` → `PaperExtractionService` | `AiJob.stage`, `PaperImportPage.status/model` |
| validation | `pageProblem()` in `extraction.schema.ts` | `PaperImportPage.escalationReason` |
| aggregation | `aggregatePages()` | `PaperImport.draft`, `.warnings` |
| confirmation | `ExamBuilderService` | `PaperImport.lessonId` / `.courseId` |

The reading runs on the **existing** `AiJob` queue — same claim with
`FOR UPDATE SKIP LOCKED`, same lease, same retry policy, same monthly budget
ceiling as academy site generation. A twenty-page import is minutes of
provider time and was never going to be an HTTP request.

---

## The cost strategy

This is the part worth reading twice, because it is the part that has a bill
attached.

**1. Free before cheap.** A PDF exported from Word carries the whole exam as
text. `pdftotext` hands that over in milliseconds for nothing, and the page is
then read as *text*, not as a picture — no image tokens at all. Only a scan or
a photograph, where the text layer is absent or is a few characters of noise
(`PAPER_IMPORT_TEXT_LAYER_MIN`), falls through to the picture.

**2. Cheap by default, always.** Every page is read by
`PAPER_IMPORT_PRIMARY_MODEL` — `gpt-6-luna` by default: vision, strict
Structured Outputs, and $0.10/$0.50 per million tokens at the time of writing.
Reading a page of an exam is transcription in a layout, which is what a small
multimodal model is good at; the flagship's advantage is reasoning nobody needs
to read "Question 3" off a page.

**3. Expensive only where the cheap one demonstrably failed, and only on that
page.** `pageProblem()` is a deterministic check on the cheap model's answer —
no questions at all, a question whose text is a fragment, a multiple-choice
question with one option, **a question that is an apology rather than a
transcription, every question on the page reading the same**, or the model's
own `lowConfidence` admission. Only a page that fails it is re-read by
`PAPER_IMPORT_FALLBACK_MODEL`. One bad photograph in a twenty-page paper costs
one escalation, not twenty.

Note the asymmetry in how the model's self-report is used: it is believed when
it says "I could not read this" and ignored when it says "I could". A model's
confidence in its own output is not evidence; its admission of failure is.

The two checks in bold are there because of a real import and are worth
keeping: a hand-written 1947 arithmetic paper came back as five questions that
all read `[نص السؤال غير واضح]`. Every structural check passed — the strings
were long enough, the types were plausible, the shape was valid — so the
fallback was never asked and a teacher got a draft of nothing. The extraction
prompt now forbids placeholders outright, `looksLikePlaceholder()` catches them
anyway, and a page whose questions all read the same escalates on that alone.

**The third tier is a person, not a rule.** Some papers neither model can read.
For those the review screen notices that most of the draft came back flagged or
repeated and offers **"read it again more carefully"**, which re-reads the whole
paper on `PAPER_IMPORT_STRONG_MODEL` (the flagship, ~20× the fallback) and
replaces the draft. Nothing reaches that model automatically: it costs real
money per page, and the only party entitled to spend it is a teacher who has
looked at a result and judged it not good enough.

**4. Pixels are the other lever — counted the way the provider counts them.**
Image tokens are 32×32 patches, and each model has a patch budget, so a page is
sized to land just inside `PAPER_IMPORT_PATCH_BUDGET` at its own aspect ratio
rather than to a flat pixel count. This started as a flat 1600px long edge,
which was ~1,900 tokens against a budget of ~3,000 — detail given up to save a
fifth of a cent on the cheap model. Two related corrections came with it:
`detail` is `original`, which is what the provider's vision guide recommends
for reading text and small detail (it was `high`, the setting for pictures being
looked at rather than read), and JPEG quality is 92 rather than 82, which is
free, because tokens come from pixel dimensions and not from file size.

**5. Aggregation is plain code.** Stitching pages into one exam is
concatenation, page-break joins and renumbering. Asking a model to do it would
mean sending every page's text a second time: the most expensive possible way
to do string concatenation, and the least predictable.

### What an import actually costs

Metered per page in **millicents** (`PaperImportPage.costMillicents`), because
a page costs a fraction of a cent and rounding each one up to a whole cent
overstated a ten-page import fivefold. The import's `costCents` is the rounded
total; the `AiJob`'s `costCents` is the same number, so existing budget
accounting keeps working untouched.

`PaperImport` also records `inputTokens`, `outputTokens`, `escalatedPages` and
`durationMs`, and each page records which model read it and why it escalated.
That is enough to answer "how much does importing a ten-page exam cost us" from
SQL alone. No dashboard was built; the data is simply there.

A rough figure at the default models: a typical scanned page is ~1.5k image
tokens in and ~1.5k JSON tokens out, so a ten-page photographed exam lands
around **1–2 cents**, and a text-layer PDF of the same exam around a tenth of
that. An escalated page costs roughly twenty times a normal one — which is why
`escalatedPages` is worth watching: if it stops being a small fraction, the
primary model is the wrong one, not the strategy.

---

## What the teacher sees

Upload → a progress screen counting pages that have **actually** come back
(never a timer) → a review screen → confirm. Closing the tab is safe at every
point: the phase is derived from the server's own status (`phaseOf`), so
reopening lands exactly where it was left.

On the review screen a teacher can edit any question's text and options, change
its type, mark the right answer, reorder, delete, add a question the extraction
missed, and open the original page beside the question it came from. Nothing
about models, tokens or escalation is shown; what is shown is which questions
to look at.

Warnings are sent as a `code` plus `params` and worded on the screen, not on
the server. The first version composed the sentences server-side, and an
Arabic teacher reviewing an Arabic exam read half of them in English — the
server does not know the language of a page it cannot see. `detail` survives
as a fallback for a client with no translation for a newer code.

**Unsupported question types are surfaced, never converted.** A matching
exercise or a diagram to label has nowhere to live in
`QuestionType {MCQ, TRUE_FALSE, SHORT_ANSWER}`. It is marked `UNSUPPORTED`,
flagged on the review screen, and confirmation is **refused** until the teacher
either changes its type or explicitly accepts losing it (`dropUnsupported`).
Silently turning it into a short answer would mark a class wrong.

---

## Where the exam ends up

An exam lives on a lesson and a lesson lives in a course, so "a standalone
exam" and "a course that is only this exam" are the same thing in this schema.
`ExamBuilderService` therefore offers two targets and no third domain:

- **`NEW_COURSE`** — a course is created, the exam lesson is added to it, and
  the course names it as its exam (`Course.examLessonId`). This is the
  exam-only course, and it needed no schema change: `addLessonDirect` already
  creates the hidden default unit, and publishing already only requires one
  lesson.
- **`EXISTING_COURSE`** — the exam lesson is added to a course the teacher
  already has, optionally as that course's exam (`FINAL` or `GATE`).

Both go through `CoursesService` and `QuizzesService` — the same two services
the manual builder calls. If this ever started writing `Quiz` rows directly,
`exam-builder.spec.ts` would fail, which is the point of it.

---

## Export

Both work for **any** exam, imported or typed in by hand: the routes take a
QUIZ lesson id.

- **PDF** is the browser's own print of a structured A4 layout
  (`ExamPrintPage` + `@media print` rules in `index.css`), the same route
  `CertificateViewPage` already takes. This is a deliberate choice, not a
  shortcut: the product is Arabic-first, and putting Arabic on a page means
  shaping letters and resolving bidirectional runs around every English term
  and every number. Every browser does that correctly and for free; no small
  PDF library does it at all, and the one that would means shipping a headless
  Chromium in the API image.
- **DOCX** is built server-side by `docx-writer.ts` — a .docx is a ZIP of XML
  parts, so it is ~150 lines of ZIP writer and WordprocessingML rather than a
  dependency with its own tree and its own opinions about bidirectional text.
  Every paragraph carries `w:bidi` and every run `w:rtl` for an Arabic paper.
  It is not a document framework and should not become one.

Neither export is a PDF of the uploaded photographs. Both are built from the
question set — a scan of the original is the thing the teacher already had.

---

## Security

Uploads are untrusted, and are treated the way every other upload here is:
an allow-list decides *what* (PNG/JPEG/WebP, or one PDF), and the bytes decide
*whether it really is that* (`assertMagicMatchesMime`, and a `%PDF` prefix
check). Size, page count and image dimensions are all capped. Nothing from an
uploaded file is executed; PDFs are handled by short-lived poppler child
processes rather than by a parser inside this process.

Authorization is the platform's ordinary academy one and nothing new:
`AcademyMembershipGuard` + `RequirePermission('course.write')`, exactly as on
`TeacherCoursesController`. Every query is scoped by `academyId` and, for a
teacher who is not a Center owner, by `tenantId` — the same rule courses
follow. There is no signed-link shortcut for viewing a source page: it is
fetched through the authorized API, because these are somebody's unpublished
exam papers.

Extraction prompts state that the page is untrusted material to be transcribed
and never obeyed.

---

## Failure

Everything is per page, and the original upload is never destroyed.

- A page that fails is marked failed; the rest of the stack carries on and the
  import ends in **REVIEW with a warning**, not in failure.
- Only a stack where *nothing* could be read ends in FAILED.
- **Retry re-reads only the failed pages.** The successful ones already hold
  their answers, and re-reading them is a second bill for work already done
  correctly. The exception is a teacher asking for the whole paper to be read
  again on the strongest model, where the pages that "succeeded" are exactly
  the ones being rejected.
- A page whose stored bytes have gone is marked failed rather than retried
  forever.
- Confirming twice is refused with the exam the first confirm produced, so one
  paper cannot become two exams.
- `aggregatePages` reports a gap in the paper's own question numbering, which
  is how a page missing from the pile shows up — the extraction cannot see it,
  because each page is read alone.

---

## Configuration

Every variable is documented in `.env.example` under "Paper exam import". The
feature rides `AI_ACADEMY_ENABLED`, `OPENAI_API_KEY`, the same queue and the
same monthly budget; turning AI off turns this off too.

Boot validation warns if the primary and fallback models are the same — that
does not break anything, it silently doubles the bill for every page that
needed a second look and nothing else would say so.

PDFs need `poppler-utils` (`pdfinfo`, `pdftoppm`, `pdftotext`) on the host. It
is in the Dockerfile, beside ffmpeg and yt-dlp, for the same reason they are.

---

## Known limits

- Handwriting is read as well as the model reads handwriting. Modern
  handwriting usually escalates to the fallback and comes back usable; a
  decades-old manuscript often needs the teacher-triggered third tier, and may
  still need editing. All of that is surfaced, never hidden — and the offer to
  re-read appears before the teacher starts retyping the exam by hand.
- An answer key is only set where the paper itself marks one. Most papers do
  not, and the review screen says so rather than guessing — a guessed key is a
  class marked wrong.
- Mathematical notation comes back as written, with LaTeX only where it cannot
  be typed literally. There is no equation rendering in the exam UI, so a
  heavily mathematical paper is legible but not typeset.
- Images inside a question (a diagram the question refers to) are not carried
  across; the question text is, and the original page is one click away.
- Sections are a reading aid on paper and the exam model has one flat question
  list, so a section heading is folded into the first question it introduces.
