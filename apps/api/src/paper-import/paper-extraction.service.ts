import { Injectable, Logger } from '@nestjs/common';
import { AiClient, AiPrice, AiReasoningEffort } from '../academy-site/ai/ai.client';
import { PaperImportConfig } from './paper-import.config';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EscalationReason,
  PAGE_EXTRACTION_SCHEMA,
  PageExtraction,
  pageProblem,
} from './extraction.schema';

/**
 * Which ladder a page is read on.
 *
 * AUTO is the normal one: cheap first, expensive only where the cheap answer
 * failed a check. STRONG skips straight to the flagship and is never chosen by
 * a rule — a teacher chooses it, having looked at a result that was not good
 * enough, which is the only party entitled to spend twenty times as much on a
 * page they have already paid to read once.
 */
export type ExtractionTier = 'AUTO' | 'STRONG';

/** What reading one page produced, and what it cost. */
export interface PageExtractionResult {
  extraction: PageExtraction | null;
  model: string;
  /** Null when the cheap model's answer was good enough — the normal case. */
  escalationReason: EscalationReason | null;
  escalated: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Thousandths of a cent. A page costs a fraction of a cent, and rounding
   *  each one up to a whole cent overstated a ten-page import fivefold. */
  millicents: number;
  error: string | null;
}

/**
 * One page in, one structured extraction out — and the decision about which
 * model reads it.
 *
 * **The cost rule this service exists to enforce: the expensive model is never
 * the default, and never runs over a whole exam.** Every page is read by the
 * cheap model first. A page is re-read by the expensive one only when the
 * cheap answer failed a deterministic check, and only that page. One bad page
 * in a twenty-page paper costs one escalation, not twenty.
 *
 * The second rule is quieter but saves more: **a page that arrives as text is
 * never sent as a picture.** A PDF with a text layer skips image tokens
 * entirely, which is most of the cost of a page.
 */
@Injectable()
export class PaperExtractionService {
  private readonly logger = new Logger(PaperExtractionService.name);

  constructor(
    private readonly ai: AiClient,
    private readonly config: PaperImportConfig,
  ) {}

  /**
   * Read one page.
   *
   * `text` is the free text layer when the source PDF carried one; `image` is
   * the normalised JPEG otherwise. Exactly one of them is used — sending both
   * would pay for the picture of a page we can already read.
   */
  async extractPage(input: {
    pageNumber: number;
    image?: Buffer;
    text?: string | null;
    tier?: ExtractionTier;
  }): Promise<PageExtractionResult> {
    // The teacher asked for the best read available. There is no cheap first
    // pass here: they have already seen what the cheap pass produced.
    if (input.tier === 'STRONG') {
      const strong = await this.readWith(
        this.config.strongModel,
        this.config.strongPrice,
        this.config.strongEffort,
        input,
      );
      return { ...strong, escalationReason: 'LOW_CONFIDENCE', escalated: true };
    }

    const first = await this.readWith(
      this.config.primaryModel,
      this.config.primaryPrice,
      this.config.primaryEffort,
      input,
    );

    // The cheap answer is kept unless something is demonstrably wrong with it.
    const problem = first.error ? 'ERROR' : pageProblem(first.extraction);
    if (!problem) return first;

    this.logger.log(
      `Page ${input.pageNumber}: escalating to ${this.config.fallbackModel} (${problem})`,
    );
    const second = await this.readWith(
      this.config.fallbackModel,
      this.config.fallbackPrice,
      this.config.fallbackEffort,
      input,
    );

    // Both calls are billed, so both are reported. Hiding the first one's
    // tokens would make an escalation look cheaper than it was, which is
    // exactly the number this feature is supposed to keep honest.
    const total = {
      inputTokens: first.inputTokens + second.inputTokens,
      outputTokens: first.outputTokens + second.outputTokens,
      millicents: first.millicents + second.millicents,
    };

    // If the better model also failed, the cheap answer is still the best
    // thing we have — a partial page a teacher can edit beats an empty one.
    const secondProblem = second.error ? 'ERROR' : pageProblem(second.extraction);
    const winner = secondProblem && !first.error ? first : second;

    return {
      ...winner,
      ...total,
      model: winner === first ? first.model : second.model,
      escalationReason: problem as EscalationReason,
      escalated: true,
      error: secondProblem && first.error ? first.error : winner.error,
    };
  }

  private async readWith(
    model: string,
    price: AiPrice,
    effort: AiReasoningEffort,
    input: { pageNumber: number; image?: Buffer; text?: string | null },
  ): Promise<PageExtractionResult> {
    const useText = !!input.text?.trim();
    // The prompt is one line plus the page. Everything else the model needs to
    // know lives in the schema's own descriptions, which are sent as part of
    // the format rather than as prose we pay for twice.
    const content = useText
      ? [
          `Page ${input.pageNumber} of an exam paper, as text extracted from the PDF.`,
          '<<<PAGE>>>',
          input.text!.slice(0, 40_000),
          '<<<END PAGE>>>',
        ].join('\n')
      : `Page ${input.pageNumber} of an exam paper. Transcribe it.`;

    try {
      const res = await this.ai.completeStructured<PageExtraction>({
        model,
        price,
        reasoningEffort: effort,
        maxTokens: this.config.maxTokens,
        // A page of an exam is small print that has to be read exactly, which
        // is the case the provider's guide names for `original`. It was
        // `high` — the setting for a picture being looked at rather than read.
        imageDetail: this.config.imageDetail,
        system: EXTRACTION_SYSTEM_PROMPT,
        schemaName: 'exam_page_extraction',
        schema: PAGE_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
        messages: [
          {
            role: 'user',
            content,
            ...(useText || !input.image
              ? {}
              : { images: [`data:image/jpeg;base64,${input.image.toString('base64')}`] }),
          },
        ],
      });
      return {
        extraction: res.data,
        model,
        escalationReason: null,
        escalated: false,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        millicents: this.ai.costMillicents(res.inputTokens, res.outputTokens, price),
        error: null,
      };
    } catch (e) {
      // A provider failure on one page is not a failure of the import: the
      // page is marked and the rest of the stack carries on. What must never
      // happen is losing the upload over it.
      const message = (e as Error).message ?? 'AI call failed';
      this.logger.warn(`Page ${input.pageNumber} failed on ${model}: ${message}`);
      return {
        extraction: null,
        model,
        escalationReason: null,
        escalated: false,
        inputTokens: 0,
        outputTokens: 0,
        millicents: 0,
        error: message.slice(0, 500),
      };
    }
  }
}
