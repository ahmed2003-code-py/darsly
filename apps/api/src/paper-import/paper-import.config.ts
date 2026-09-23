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

  /** Ceiling on how much lecture material one session may hold, in pages.
   *  Fifty pages is a chapter; past that a teacher is uploading a textbook. */
  readonly maxContentPages = Math.max(1, num(process.env.PAPER_IMPORT_MAX_CONTENT_PAGES, 60));
}
