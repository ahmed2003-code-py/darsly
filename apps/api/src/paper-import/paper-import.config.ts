import { Injectable } from '@nestjs/common';
import { AiPrice, AiReasoningEffort } from '../academy-site/ai/ai.client';

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

  /** Reading a page off a picture is not a reasoning problem. `low` on the
   *  first pass; the escalation buys thinking as well as a bigger model. */
  readonly primaryEffort = (process.env.PAPER_IMPORT_PRIMARY_EFFORT ?? 'low') as AiReasoningEffort;
  readonly fallbackEffort = (process.env.PAPER_IMPORT_FALLBACK_EFFORT ??
    'medium') as AiReasoningEffort;

  /** A stack, not a textbook. Past this the teacher is importing the wrong
   *  thing and the bill is real. */
  readonly maxPages = Math.max(1, num(process.env.PAPER_IMPORT_MAX_PAGES, 25));
  /** Per uploaded file, in bytes. A phone photo is 3–8 MB. */
  readonly maxImageBytes = num(process.env.PAPER_IMPORT_MAX_IMAGE_SIZE, 15 * 1024 * 1024);
  readonly maxPdfBytes = num(process.env.PAPER_IMPORT_MAX_PDF_SIZE, 40 * 1024 * 1024);
  /**
   * Longest edge of the picture actually sent to the model, in pixels.
   *
   * Image tokens scale with area, so this is the single biggest lever on cost.
   * 1600 is enough to read 10pt Arabic print off an A4 scan; going to 2200
   * nearly doubles the tokens and changed nothing in the answers.
   */
  readonly maxRenderDim = Math.max(600, num(process.env.PAPER_IMPORT_RENDER_DIM, 1600));
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
}
