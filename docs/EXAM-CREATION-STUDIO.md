# Exam Creation Studio

Two ways for a teacher to get an exam, and one exam at the end of both.

- **لدي امتحان جاهز** — they photograph the exam they already have (or attach
  the PDF), check what came off it, and confirm.
- **إنشاء امتحان من محتوى** — they upload the lectures they teach from, say
  how many questions of what kind they want, and check what was written.

Both produce an ordinary Darsly `Quiz` on an ordinary QUIZ `Lesson`. The
student side, the grading, the gating, the certificates and the leaderboards
know nothing about either path, and both meet at the same review screen —
`ExamReviewPanel`, used by both, because two review screens would have meant
every later improvement to one of them quietly not existing in the other.

This is an **authoring pipeline into the existing exam model**, not a second
exam engine.

> **On the table names.** The rows are still `PaperImport` and
> `PaperImportPage`, from when the studio only did the first path. They now
> carry a `kind` (`PAPER` | `CONTENT`) and hold both. The name was left alone
> deliberately: renaming a live table for tidiness is a migration's worth of
> risk bought with nothing, and the domain language everywhere above the
> database — module, routes, UI — is the studio's.

---

## The two paths

```
                        ┌──────────── PAPER ────────────┐
upload → validate → store ─┤                               ├─ review → confirm → Quiz
                        └─── CONTENT ── spec ───────────┘
```

| | PAPER | CONTENT |
|---|---|---|
| what is uploaded | an exam | lecture material |
| reading | questions are found | words are transcribed |
| in between | — | the teacher says what exam they want |
| writing | — | questions are written from chunks, in batches |
| grounding | the page it came off | the chunk, file and page it came from |
| rewriting one | — | yes, from the same material |

The teacher speaks in the middle of the content path, which is why it is two
jobs rather than one: reading is cheap and tells us whether there is anything
here at all, and writing twenty questions before anyone has said how many were
wanted is a bill for a guess.

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

## Writing an exam from lecture material

Everything before the model is deterministic and free, and that is most of the
work:

1. **The text layer, when there is one.** A lecture exported from slides or a
   word processor carries its own text; `pdftotext` hands it over in
   milliseconds and the page costs **zero tokens**. Measured, not estimated: a
   one-page Arabic lecture PDF read end to end locally cost 0 tokens and 0
   cents. Only a scan or a photograph is read by a model.
2. **Cleanup** (`normalizePageText`, `stripRunningLines`) — hyphenated line
   breaks rejoined, page numbers dropped, bidi marks stripped, and the running
   header removed by noticing it repeats on most pages. On a fifty-page lecture
   that header is fifty copies of the same sentence in the material questions
   get written from.
3. **Chunking** (`chunkSource`) — paragraph-aligned chunks of ~700 tokens that
   never span two pages, each carrying the teacher's own file name and page so
   a question can say *"biology.pdf — صفحة 8"* and mean it.
4. **Selection** (`selectChunksForBatch`) — batch 1 gets the opening of the
   material, batch 2 the next stretch, so a twenty-question exam on a fifty-page
   lecture asks about the whole lecture rather than its first chapter four
   times.

Then the model writes, in **batches** (`PAPER_IMPORT_BATCH_SIZE`, default 8),
never one call per question — that pays for the same instructions and the same
source material once per question, and it is how a model writes the same
question twice without knowing it.

**Grounding is a fact, not a claim.** Every generated question must name the
chunk it came from, and a question naming a chunk it was not given is dropped
before the teacher sees it. A model asked for twenty questions from material
that supports thirteen will happily write twenty; seven of them would be about
things the lecture never said, and a teacher who does not catch it sets an exam
on content their class was never taught. So the schema has a place to say
*"this supports fewer than you asked for"*, the prompt says it twice, and the
shortfall reaches the teacher as a warning with an offer — upload more, or ask
for fewer — rather than as seven invented questions.

**The material decides how big the exam can be, before anything is spent.**
`supportableQuestions()` works the ceiling out from the chunks — roughly one
question per 70 tokens, at most six per chunk — and the plan is cut to it.
Without this, a request for twenty questions from a single page became three
batches over the *same* paragraph, each repeating the last, every repeat thrown
away as a duplicate, the shortfall read as a model failure and all three
batches escalated to the flagship: six calls and ten minutes to produce
thirteen questions that one call had already produced.

**A short answer is not a failure.** A batch that comes back with fewer
questions than asked, none of them broken, is a batch that wrote what the
paragraph supports; a bigger model reading the same paragraph does not lengthen
it. Escalation now needs something to have come back *wrong*, and a short batch
ends the loop rather than starting another over the same chunks.

**The specification reconciles itself.** When the material carries thirteen of
the twenty asked for, the stored spec is rewritten to describe the exam that
exists — 13, split 7/3/3 in the proportions the teacher chose. The review
screen then asks, once, in a dialog: *"اللي رفعته يكفي لـ 13 سؤال كويس، مش 20…
تمام كده، ولا تحب تغيّر المواصفات وترفع مادة أكتر؟"* Saying yes is genuinely
nothing — the exam is ready to publish as it stands. Saying no opens the
settings on the real numbers. Before this the spec kept insisting on twenty
over a draft of thirteen, so "change the settings" opened a form the teacher
had to correct by hand, with a number they never chose.

**Rewriting one question is one question.** The review screen's «أعد الكتابة»
sends that question's own chunk plus the nearest few, every *other* question so
the rewrite is not one of them, and the teacher's reason if they gave one. It
costs one small call, not a new exam.

**Duplicates are caught deterministically.** `similarity()` is word overlap on
Arabic folded for diacritics, alef forms and ta marbuta — so «الطاقة» and
«الطّاقه» compare equal and a duplicate is not hidden by spelling. No
embeddings: there is no vector store in this project, a lecture is tens of
chunks rather than millions, and two questions written from the same paragraph
in the same call repeat each other's words when they repeat each other.

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

### The three tiers, and who reaches them

| tier | model (default) | reached by |
|---|---|---|
| read a page | `gpt-6-luna` | every page, always |
| read it properly | `gpt-6-sol` | a page that failed a deterministic check |
| write questions | `gpt-6-sol` | every batch |
| write them properly | `gpt-6-astra` | a batch that already failed twice |
| read it *really* properly | `gpt-6-astra` | **a teacher pressing a button** |

The flagship is never a default anywhere. Transcribing is copying and the cheap
model does it well; writing a fair question with a defensible key and three
plausible wrong options is not copying, which is why generation starts a tier
up. Nothing automatic reaches `astra` except a batch that has already failed
twice on the same material.

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

## What the teacher sees, and how progress stays honest

Choose a path → upload → a progress screen → (the specification, on the content
path) → review → confirm.

**Progress is the worker's own record.** `PaperImport.stage` and
`progressDone`/`progressTotal` are written by the worker as it finishes each
unit — a page on the way in, a batch of questions on the way out — and the
screen reads them. Nothing is interpolated and nothing moves on a timer:

- *"8 من 12 صفحة"* means eight pages actually came back.
- *"اتكتب 14 من 20 سؤال"* means fourteen questions passed the checks.
- Five named steps, ticked from `stage`, so "قراءة الصفحات ✓" means the worker
  finished reading.
- A per-page breakdown behind a closed «تفاصيل المعالجة», because it is useful
  when something is stuck on one page and noise the rest of the time.
- Where the work genuinely cannot be counted yet, the bar is **indeterminate**
  and the stage text carries the meaning. That is the honest version of "still
  working" — a bar crawling 0 → 50 → 100 while nothing happens is a lie that
  costs a teacher their trust the first time it reaches 100 and the page does
  not change.

Because all of it lives on the row rather than in the browser, closing the tab
is safe at every point and reopening lands exactly where the work is. Nine
user-visible states are derived in one place (`creationState`): `PROCESSING`,
`RETRYING`, `HIGH_ACCURACY`, `NEEDS_SPEC`, `READY`, `NEEDS_REVIEW`,
`HIGH_ACCURACY_AVAILABLE`, `FAILED`, `DONE`. "Reading this again, more slowly"
and "reading this" are different things to be told, and showing one spinner for
both is how a screen comes to look frozen.

**Cancel** stops the work that has not happened yet and keeps every uploaded
file: a teacher cancelling a generation has decided this *exam* was wrong, not
that the lecture was, and throwing away the material would mean uploading it
again to try different settings — which is the commonest reason to cancel.

On the review screen a teacher can edit any question's text and options, change
its type, mark the right answer, reorder, delete, add a question the extraction
missed, and open the original page beside the question it came from. Nothing
about models, tokens or escalation is shown; what is shown is which questions
to look at.

**Every refusal in the studio is a pop-up**, not a red line under a control:
half of them happen after the teacher has scrolled away from whatever caused
them, and an inline note on a long review screen is a note nobody reads. Each
code the studio can return has Arabic copy, so none of them degrades to a bare
status sentence — and a label with a count in it is passed that count, because
a `t()` call that forgets its parameters puts «خليه {{got}} سؤال» on a button:
the interpolation variable's name, in front of the teacher.

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

## Recovery

Nothing is ever redone that does not need redoing.

- A page that fails is retried alone; pages 1–6 are not re-read because page 7
  failed.
- A batch that fails validation is rewritten alone; the other batches stand.
- Good questions inside a failed batch are **kept** — seven good and one broken
  is seven kept and one asked for again.
- The teacher-triggered high-accuracy read is the one deliberate exception: it
  re-reads the whole paper, because the pages that "succeeded" are exactly the
  ones being rejected.
- Rewriting question 7 rewrites question 7.

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
- **There is no separate "essay" question type.** The exam engine stores three
  types, and offering a fourth on the specification form that silently became
  one of the three would be a promise the exam cannot keep. A long written
  answer is a `SHORT_ANSWER` with more marks and more ruled space on the
  printed paper.
- Question generation has been verified against a **mocked** provider only.
  The deterministic half of the content path — upload, text-layer extraction,
  cleanup, chunking — was verified end to end against the real API, worker and
  database, and cost nothing. No automated test calls a paid API, and no real
  generation has been measured.
- Chunk selection is coverage-first with word-overlap for rewrites. It has no
  notion of *topic*, so a teacher asking for twenty questions "about
  photosynthesis" from a mixed lecture gets twenty questions about the whole
  lecture. Topic targeting would need retrieval this feature does not have.
- Source material is read page by page; a table or a diagram spanning two pages
  is chunked as two.
