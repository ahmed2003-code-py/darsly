import { Injectable } from '@nestjs/common';
import { AiImageDetail, AiPrice, AiReasoningEffort } from '../academy-site/ai/ai.client';

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Runtime configuration for paper exam import.
 *
 * Follows the same shape as AcademySiteConfig — env only, read once, no second
 * configuration system. The master AI kill-switch is still
 * AI_ACADEMY_ENABLED: this feature rides the same client, the same queue and
 * the same monthly budget, so turning AI off turns this off too.
 *
 * The two models are the whole cost story. The primary reads every page; the
 * fallback reads only the pages the primary got wrong, and how often that
 * happens is visible in PaperImport.escalatedPages. Both are configurable
 * because the right model on the day this shipped is not the right model
 * forever, and a price change must not need a deploy.
 */
@Injectable()
export class PaperImportConfig {
  /**
   * The cheap one, and the default for every page.
   *
   * gpt-6-luna: vision and strict Structured Outputs, a 1.05M context, and
   * $0.10/$0.50 per million tokens at the time of writing — roughly a fiftieth
   * of the flagship. An exam page is a picture of text in a layout, which is
   * the kind of work a small model with image input does well; the flagship's
   * advantage is reasoning nobody needs to read "Question 3" off a page.
   */
  readonly primaryModel = process.env.PAPER_IMPORT_PRIMARY_MODEL ?? 'gpt-6-luna';
  /**
   * The expensive one, for pages the cheap one could not read: dense
   * mathematics, a two-column layout that interleaved, a table, handwriting.
   * Never the default — escalation is per page, never per import.
   */
  readonly fallbackModel = process.env.PAPER_IMPORT_FALLBACK_MODEL ?? 'gpt-6-sol';
  /**
   * The one a teacher asks for by hand, and nothing asks for on its own.
   *
   * There is a kind of paper the two models above cannot read: a hand-written
   * exam from decades ago, faded ink, a script nobody writes any more. The
   * flagship reads those — it is what a teacher gets if they photograph the
   * same page into ChatGPT — and it costs twenty times the fallback, so it is
   * never reached by an automatic rule. It runs only when a teacher looks at a
   * bad result and presses "read it again more carefully", which is a person
   * spending their own budget on a page they have seen.
   */
  readonly strongModel = process.env.PAPER_IMPORT_STRONG_MODEL ?? 'gpt-6-astra';

  /** Cents per million tokens, so cost is right per call rather than per
   *  AI_MODEL. Defaults are the published prices for the models above. */
  readonly primaryPrice: AiPrice = {
    inPerMToken: num(process.env.PAPER_IMPORT_PRIMARY_PRICE_IN, 10),
    outPerMToken: num(process.env.PAPER_IMPORT_PRIMARY_PRICE_OUT, 50),
  };
  readonly fallbackPrice: AiPrice = {
    inPerMToken: num(process.env.PAPER_IMPORT_FALLBACK_PRICE_IN, 200),
    outPerMToken: num(process.env.PAPER_IMPORT_FALLBACK_PRICE_OUT, 1000),
  };
  readonly strongPrice: AiPrice = {
    inPerMToken: num(process.env.PAPER_IMPORT_STRONG_PRICE_IN, 1000),
    outPerMToken: num(process.env.PAPER_IMPORT_STRONG_PRICE_OUT, 5000),
  };

  /** Reading a page off a picture is not a reasoning problem. `low` on the
   *  first pass; the escalation buys thinking as well as a bigger model. */
  readonly primaryEffort = (process.env.PAPER_IMPORT_PRIMARY_EFFORT ?? 'low') as AiReasoningEffort;
  /**
   * The escalation buys thinking as well as a bigger model. `high`, not
   * `medium`: a page reaches the fallback only because the first read of it
   * was demonstrably wrong, and the thing that reads an unclear word is
   * reading the words around it — which is what the effort pays for.
   */
  readonly fallbackEffort = (process.env.PAPER_IMPORT_FALLBACK_EFFORT ??
    'high') as AiReasoningEffort;
  readonly strongEffort = (process.env.PAPER_IMPORT_STRONG_EFFORT ?? 'high') as AiReasoningEffort;

  /**
   * How hard the provider looks at the page.
   *
   * `original`, which is what the provider's own vision guide recommends for
   * optical character recognition and small detail. This was `high` — a
   * setting for pictures that are being looked at rather than read — which is
   * the wrong end of the only choice that matters for a page of handwriting.
   */
  readonly imageDetail = (process.env.PAPER_IMPORT_IMAGE_DETAIL ?? 'original') as AiImageDetail;

  /** A stack, not a textbook. Past this the teacher is importing the wrong
   *  thing and the bill is real. */
  readonly maxPages = Math.max(1, num(process.env.PAPER_IMPORT_MAX_PAGES, 25));
  /** Per uploaded file, in bytes. A phone photo is 3–8 MB. */
  readonly maxImageBytes = num(process.env.PAPER_IMPORT_MAX_IMAGE_SIZE, 15 * 1024 * 1024);
  readonly maxPdfBytes = num(process.env.PAPER_IMPORT_MAX_PDF_SIZE, 40 * 1024 * 1024);
  /**
   * How big a picture is worth sending, counted the way the provider counts
   * it: in 32x32 pixel patches, which is what image tokens actually are.
   *
   * This used to be a flat 1600px long edge, chosen to hold cost down. That
   * reasoning was half right and the number was too small: a page sent at
   * 1600px is ~1,900 image tokens, the model's own budget allows ~2,500
   * patches (~3,000 tokens), and the difference is a fifth of a cent on the
   * cheap model. A fifth of a cent is not a reason to send a blurrier
   * photograph of somebody's handwriting.
   *
   * Sizing to the budget rather than to a pixel count also means an A4 page
   * and a phone snapshot both arrive at the resolution the model can actually
   * use, instead of one of them being wasted and the other starved.
   */
  readonly renderPatchBudget = Math.max(256, num(process.env.PAPER_IMPORT_PATCH_BUDGET, 2500));
  /** A hard ceiling on the long edge, whatever the budget works out to. */
  readonly maxRenderDim = Math.max(600, num(process.env.PAPER_IMPORT_RENDER_DIM, 2400));
  /**
   * How big the stored copy of a page is, in pixels on its long edge.
   *
   * Deliberately larger than anything one model call can use. This copy is
   * what every later crop is taken from, and a crop of one question wants the
   * detail the page pass could not spend — so storing a page already squeezed
   * to a page-sized budget would throw away the thing that makes re-reading
   * work. The untouched upload is kept as well; this is the working copy.
   */
  readonly storedPageDim = Math.max(1200, num(process.env.PAPER_IMPORT_STORED_DIM, 3000));
  /** Quality of that stored copy. Bytes, not tokens — it is never sent. */
  readonly storedPageQuality = Math.min(
    100,
    Math.max(60, num(process.env.PAPER_IMPORT_STORED_QUALITY, 90)),
  );

  /**
   * JPEG quality of the page that is sent.
   *
   * Free, and that is the whole point: image tokens are counted from the pixel
   * dimensions, not from the file size, so a more compressed picture costs
   * exactly the same as a clean one and only loses strokes. 82 was a number
   * carried over from thinking about bytes.
   */
  readonly renderQuality = Math.min(
    100,
    Math.max(40, num(process.env.PAPER_IMPORT_RENDER_QUALITY, 92)),
  );
  /** Output ceiling per page. A dense page of MCQs is ~1.5k tokens of JSON. */
  readonly maxTokens = Math.max(500, num(process.env.PAPER_IMPORT_MAX_TOKENS, 6000));
  /**
   * How many characters of real text a PDF page must carry before its text
   * layer is trusted instead of its picture.
   *
   * A PDF exported from Word has the whole exam in it as text — sending a
   * picture of that page is paying image tokens for something already free.
   * A scan has a text layer of nothing, or of OCR garbage a few characters
   * long, and falls through to the picture.
   */
  readonly textLayerMinChars = Math.max(0, num(process.env.PAPER_IMPORT_TEXT_LAYER_MIN, 250));

  // ── Writing an exam from lecture material ────────────────────────────────
  //
  // Reading a lecture page is the same job as reading an exam page, so it uses
  // the same two models above and needs no configuration of its own. Writing
  // questions is a different job, and gets its own.

  /**
   * The model that writes the questions.
   *
   * The middle tier, not the cheap one and not the flagship. Transcribing a
   * page is copying; writing a fair exam question with a defensible key and
   * three wrong-but-plausible options is not, and the cheap model's questions
   * are noticeably thinner. At roughly six cents for a twenty-question exam
   * this is affordable in a way the flagship (a dollar or so for the same
   * work) is not, which is why the flagship stays where it is: reserved for a
   * batch that has already failed, or for a teacher who asked.
   */
  readonly generationModel = process.env.PAPER_IMPORT_GENERATION_MODEL ?? 'gpt-6-sol';
  readonly generationPrice: AiPrice = {
    inPerMToken: num(process.env.PAPER_IMPORT_GENERATION_PRICE_IN, 200),
    outPerMToken: num(process.env.PAPER_IMPORT_GENERATION_PRICE_OUT, 1000),
  };
  readonly generationEffort = (process.env.PAPER_IMPORT_GENERATION_EFFORT ??
    'medium') as AiReasoningEffort;

  /**
   * How many questions one model call writes.
   *
   * Never one call per question — that is the same instructions and the same
   * source material paid for twenty times, and it is also how a model ends up
   * writing the same question twice without knowing it. Eight is large enough
   * to amortise the prompt and to let the model avoid repeating itself, small
   * enough that a failed batch is a cheap thing to retry.
   */
  readonly generationBatchSize = Math.max(
    1,
    Math.min(20, num(process.env.PAPER_IMPORT_BATCH_SIZE, 8)),
  );

  /** Source material sent with one batch, in approximate tokens. A ceiling on
   *  the biggest single lever on generation cost. */
  readonly generationSourceTokens = Math.max(
    500,
    num(process.env.PAPER_IMPORT_BATCH_SOURCE_TOKENS, 6000),
  );

  /** How many times a batch that fails deterministic validation is written
   *  again before the shortfall is simply reported to the teacher. Two, then
   *  stop: a third attempt on the same material rarely reads differently and
   *  the teacher can write the missing question faster than we can. */
  readonly generationMaxAttempts = Math.max(
    1,
    Math.min(4, num(process.env.PAPER_IMPORT_GENERATION_ATTEMPTS, 2)),
  );

  /**
   * How many rounds of variants may be written to reach the requested count.
   *
   * A teacher who asked for twenty questions is asking for a twenty-question
   * paper, and being handed thirteen with an explanation solves the honesty
   * problem and not the teacher's. The shortfall is filled by varying what the
   * material did support — see `QuestionGeneratorService.generateVariants`.
   *
   * Two rounds, because each round is a model call against the same material
   * and a third almost always returns what the second already did. Set to 0 to
   * go back to reporting the shortfall and stopping.
   */
  readonly generationVariantRounds = Math.max(
    0,
    Math.min(4, num(process.env.PAPER_IMPORT_VARIANT_ROUNDS, 2)),
  );

  /** Ceiling on how much lecture material one session may hold, in pages.
   *  Fifty pages is a chapter; past that a teacher is uploading a textbook. */
  readonly maxContentPages = Math.max(1, num(process.env.PAPER_IMPORT_MAX_CONTENT_PAGES, 60));

  // ── Reading a page ───────────────────────────────────────────────────────
  //
  // Transcription is now several passes rather than one call, and these are
  // the thresholds that decide how many. They are the whole cost/accuracy
  // dial: raise them and more regions get a second, closer look; lower them
  // and a hard page is accepted as read.

  /**
   * Output ceiling for a transcription call, separately from the rest.
   *
   * Transcribing a dense page is the longest output this product asks for —
   * every word on the sheet, plus a confidence and an uncertainty list per
   * region — and a reasoning model spends part of the same budget thinking
   * before it writes any of it. The shared 6,000 was set for extraction, and
   * a run that exceeds it comes back as half a JSON document.
   */
  readonly ocrMaxTokens = Math.max(2000, num(process.env.PAPER_IMPORT_OCR_MAX_TOKENS, 16000));

  /**
   * At or above this, a region is taken as read and never looked at again.
   *
   * 0.90 is deliberately high for a document that becomes an exam. A wrong
   * number in a question costs a class their marks and nobody finds out; a
   * needless crop costs a fraction of a cent.
   */
  readonly ocrAcceptConfidence = num(process.env.PAPER_IMPORT_OCR_ACCEPT, 0.9);
  /**
   * Below this, the region is re-read from a crop of the original.
   *
   * Between the two thresholds a region is checked rather than re-read: its
   * flagged fragments get cropped, the rest of it stands.
   */
  readonly ocrVerifyConfidence = num(process.env.PAPER_IMPORT_OCR_VERIFY, 0.7);
  /** Past this many re-reads of one region, stop and mark what is left
   *  unreadable. A third look at the same pixels rarely says anything new. */
  readonly ocrMaxRegionPasses = Math.max(
    1,
    Math.min(4, num(process.env.PAPER_IMPORT_OCR_REGION_PASSES, 2)),
  );
  /**
   * How many regions of one page may be re-read before the page is simply
   * re-read whole.
   *
   * Past this the page is not a good page with a bad question on it; it is a
   * bad page, and eleven crops of a bad page cost more than one better look.
   */
  readonly ocrMaxRegionCrops = Math.max(
    0,
    // Ten, not six: a seven-question page is ordinary, and a cap of six left
    // its last question unread. A crop is a smaller picture than the page it
    // came from, so ten of them is not the extravagance the low number
    // implied it was.
    Math.min(30, num(process.env.PAPER_IMPORT_OCR_MAX_CROPS, 10)),
  );
  /** How many flagged fragments inside one region get their own crop. */
  readonly ocrMaxFragmentCrops = Math.max(
    0,
    Math.min(10, num(process.env.PAPER_IMPORT_OCR_MAX_FRAGMENTS, 3)),
  );
  /** Turn the whole multi-pass pipeline off and read pages in one call, as
   *  the studio did before it existed. A way back, not a default. */
  readonly ocrMultiPass = (process.env.PAPER_IMPORT_OCR_MULTIPASS ?? 'true') !== 'false';

  /**
   * How many regions of one page are re-read at the same time.
   *
   * They are independent — a crop of question 3 does not need the answer for
   * question 2 — and they used to go one after another, so a handwritten page
   * where every region was doubtful was ten crops times two passes in a row:
   * a quarter of an hour on one sheet. Five at once turns that into a couple
   * of rounds. Set to 1 to get the old behaviour back.
   */
  readonly ocrConcurrency = Math.max(
    1,
    Math.min(10, num(process.env.PAPER_IMPORT_OCR_CONCURRENCY, 5)),
  );

  /**
   * The longest one reading call may take before it is given up on, and how
   * many times it may be retried. Unset, the SDK waits ten minutes and retries
   * twice — thirty minutes for one stalled call on a page somebody is
   * watching. A read that does not come back in two minutes is not coming
   * back; the page's other passes carry on without it.
   */
  readonly ocrCallTimeoutMs = Math.max(
    15_000,
    num(process.env.PAPER_IMPORT_OCR_CALL_TIMEOUT_MS, 120_000),
  );
  readonly ocrCallRetries = Math.max(
    0,
    Math.min(3, num(process.env.PAPER_IMPORT_OCR_CALL_RETRIES, 1)),
  );

  // ── Reading a page: the adaptive strategy ────────────────────────────────
  //
  // `current` is the multi-pass transcriber above, unchanged. `adaptive` is
  // AdaptiveReaderService: crops from the page's own lines rather than from a
  // count the cheap model guessed, the reader chosen from evidence, and a
  // deterministic reason behind every escalation. Both stay available so one
  // can be measured against the other on the same pages.

  readonly extractionStrategy: 'current' | 'adaptive' =
    process.env.EXAM_EXTRACTION_STRATEGY === 'adaptive' ? 'adaptive' : 'current';

  /** The reader for a page the cheap model could not read, and its effort at
   *  each rung. High is the last rung, not the second. */
  readonly adaptiveReaderEffort = (process.env.ADAPTIVE_READER_EFFORT ??
    'low') as AiReasoningEffort;
  readonly adaptiveRecoveryEffort = (process.env.ADAPTIVE_RECOVERY_EFFORT ??
    'medium') as AiReasoningEffort;
  readonly adaptiveLastResortEffort = (process.env.ADAPTIVE_LAST_RESORT_EFFORT ??
    'high') as AiReasoningEffort;
  /** Whether `high` may be used at all. On by default, but only reachable
   *  through the evidence rules in AdaptiveReaderService. */
  readonly adaptiveAllowHigh = (process.env.ADAPTIVE_ALLOW_HIGH ?? 'true') !== 'false';

  /**
   * Above this share of [UNCLEAR] in its whole-page pass, the cheap model is
   * not a reader for this page. Measured, not guessed: on the three benchmark
   * pages it returned 100% [UNCLEAR] on the two it could not read — and, given
   * crops of the same pages, invented exam questions with 0.45–0.74 confidence.
   */
  readonly adaptiveCheapUnclearMax = num(process.env.ADAPTIVE_CHEAP_UNCLEAR_MAX, 0.35);

  /** Lines per crop: enough context to hold a question, few enough that one
   *  crop does not swallow three of them. */
  readonly adaptiveMaxLinesPerChunk = Math.max(
    2,
    Math.min(12, num(process.env.ADAPTIVE_MAX_LINES_PER_CHUNK, 6)),
  );

  /**
   * How tall one line of text is made in a crop, in pixels.
   *
   * Image tokens are counted from pixels, so a crop is sized to what reading
   * needs rather than blown up to the patch budget. The current path enlarged
   * a five-line strip to 4800px wide — thousands of tokens of interpolated
   * pixels that hold no information the original did not.
   */
  readonly adaptiveLinePx = Math.max(24, Math.min(96, num(process.env.ADAPTIVE_LINE_PX, 56)));

  /**
   * What reading one page may cost before recovery stops climbing, in cents.
   * Past it, nothing dearer than low effort is started and what is still
   * unread is flagged for review — an honest gap, never a silent one.
   */
  readonly adaptivePageBudgetCents = Math.max(1, num(process.env.ADAPTIVE_PAGE_BUDGET_CENTS, 10));

  /**
   * Several crops in one call rather than one call each. On by default
   * because it was measured, not assumed: on the three benchmark pages it cut
   * the cost of a handwritten page to about a third (2.8–3.4¢ against
   * 8.9–10.8¢ for the 1927 exam) with the same recall and slightly better
   * transcription, over repeated runs. A batched answer that does not line up
   * one-to-one with its crops is thrown away and the crops read singly.
   */
  readonly adaptiveBatch = (process.env.ADAPTIVE_BATCH ?? 'true') !== 'false';
  /** At most this many crops in one batched call. */
  readonly adaptiveBatchSize = Math.max(1, Math.min(12, num(process.env.ADAPTIVE_BATCH_SIZE, 6)));
}
