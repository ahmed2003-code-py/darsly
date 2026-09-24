import { Injectable, Logger } from '@nestjs/common';
import { withAiTrace } from '../academy-site/ai/ai-trace';
import { AiClient, AiPrice, AiReasoningEffort } from '../academy-site/ai/ai.client';
import { PaperImportConfig } from './paper-import.config';
import { PagePhase, TranscriberService } from './ocr/transcriber.service';

/** Everything the reader says while it works, plus the step after it. */
export type ReadPhase = PagePhase | { phase: 'SHAPING' };
import { STRUCTURE_SYSTEM, structurePrompt, transcriptAsFallback } from './ocr/structure.schema';
import { PageTranscript } from './ocr/transcript.schema';
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
  /**
   * What actually happened to this page, so a failure can be described
   * instead of being flattened into "nothing readable". Absent on the
   * single-call path, which predates the distinction.
   */
  outcome?: string;
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
    private readonly transcriber: TranscriberService,
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
    onPhase?: (phase: ReadPhase) => void;
  }): Promise<PageExtractionResult> {
    // A photograph goes through the transcription pipeline: read the page,
    // then decide its shape from the words. A page that arrived as text has
    // nothing to read and goes straight to the shaping call below.
    if (input.image && !input.text?.trim() && this.config.ocrMultiPass) {
      return this.transcribeThenStructure(input.pageNumber, input.image, input.tier, input.onPhase);
    }

    // One call reads and shapes at once here, so it is one step on the screen.
    input.onPhase?.({ phase: input.text?.trim() ? 'SHAPING' : 'READING' });

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

  /**
   * Read the page, then work out its shape from what was read.
   *
   * Two stages because they are two jobs. Reading faded handwriting is visual,
   * expensive and irreversible — get it wrong and nothing downstream can tell.
   * Deciding that three of those lines are the options of question four is
   * textual, costs a twentieth as much, and can be redone from the transcript
   * any number of times without touching the photograph again.
   *
   * Doing them in one call, which is what this did before, meant a layout
   * mistake and a reading mistake arrived indistinguishable from each other.
   */
  private async transcribeThenStructure(
    pageNumber: number,
    image: Buffer,
    tier?: ExtractionTier,
    onPhase?: (phase: ReadPhase) => void,
  ): Promise<PageExtractionResult> {
    const read = await this.transcriber.transcribe(image, {
      pageNumber,
      tier: tier === 'STRONG' ? 'STRONG' : 'AUTO',
      onPhase,
    });

    if (!read.transcript) {
      return {
        extraction: null,
        model: this.config.primaryModel,
        outcome: read.outcome,
        escalationReason: 'ERROR',
        escalated: read.cost.escalated,
        inputTokens: read.cost.inputTokens,
        outputTokens: read.cost.outputTokens,
        millicents: read.cost.millicents,
        error: read.error ?? 'Page could not be transcribed',
      };
    }
    if (read.transcript.blank) {
      return {
        extraction: {
          examTitle: '',
          instructions: [],
          sectionTitle: '',
          blank: true,
          questions: [],
        },
        model: this.config.primaryModel,
        escalationReason: null,
        escalated: read.cost.escalated,
        inputTokens: read.cost.inputTokens,
        outputTokens: read.cost.outputTokens,
        millicents: read.cost.millicents,
        error: null,
      };
    }

    onPhase?.({ phase: 'SHAPING' });
    const shaped = await this.structure(read.transcript, pageNumber);

    /**
     * Never lose a page that was read.
     *
     * This is the line production died on. `shaped.data` came back as an
     * object with an EMPTY questions array — truthy — so the `??` never
     * reached the fallback, the page became zero questions, and the teacher
     * was told «مفيش حاجة مقروءة طلعت من الصفحات دي» about a page whose text
     * had been transcribed successfully a moment earlier.
     *
     * The expensive, irreversible half is the reading. If that worked, its
     * words reach the teacher even when the cheap half that shapes them did
     * not: retyping a paragraph takes minutes, re-photographing a page means
     * going back to wherever the paper is.
     */
    const shapedNothing = !shaped.data?.questions?.length;
    const transcriptHasText = read.transcript.regions.some((r) => (r.text ?? '').trim().length > 4);
    const extraction =
      shapedNothing && transcriptHasText ? transcriptAsFallback(read.transcript) : shaped.data;

    if (shapedNothing && transcriptHasText) {
      this.logger.warn(
        `Page ${pageNumber}: structuring produced no questions — keeping the transcript as ` +
          `${read.transcript.regions.length} written question(s) rather than losing the page`,
      );
    }
    // Confidence from the reading flows into the flag the review screen
    // already understands, so a question nobody could read cleanly arrives
    // marked rather than looking as settled as the rest.
    if (extraction) {
      extraction.questions = extraction.questions.map((q) => ({
        ...q,
        lowConfidence: q.lowConfidence || read.needsReview,
      }));
    }

    this.logger.log(
      `Page ${pageNumber}: ${read.outcome} in ${read.cost.calls} call(s) ` +
        `(${read.cost.cropCalls} crop), visual=${read.confidence.visual.toFixed(2)} ` +
        `read=${read.confidence.transcription.toFixed(2)} seg=${read.confidence.segmentation}, ` +
        `${((read.cost.millicents + shaped.millicents) / 1000).toFixed(2)}¢`,
    );

    return {
      extraction,
      outcome: read.outcome,
      model: this.config.primaryModel,
      // Reported as an escalation only when one actually happened, so the
      // number that watches the cheap-first strategy stays honest.
      escalationReason: read.cost.escalated ? 'LOW_CONFIDENCE' : null,
      escalated: read.cost.escalated,
      inputTokens: read.cost.inputTokens + shaped.inputTokens,
      outputTokens: read.cost.outputTokens + shaped.outputTokens,
      millicents: read.cost.millicents + shaped.millicents,
      error: null,
    };
  }

  /** The cheap half: questions out of words, no pixels involved. */
  private async structure(transcript: PageTranscript, pageNumber: number) {
    const price = this.config.primaryPrice;
    try {
      const res = await withAiTrace(
        { stage: 'OCR_STRUCTURE', meta: { model: this.config.primaryModel } },
        () =>
          this.ai.completeStructured<PageExtraction>({
            timeoutMs: this.config.ocrCallTimeoutMs,
            maxRetries: this.config.ocrCallRetries,
            model: this.config.primaryModel,
            price,
            reasoningEffort: this.config.primaryEffort,
            maxTokens: this.config.maxTokens,
            system: STRUCTURE_SYSTEM,
            schemaName: 'exam_page_extraction',
            schema: PAGE_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
            messages: [{ role: 'user', content: structurePrompt(transcript, pageNumber) }],
          }),
      );
      return {
        data: res.data,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        millicents: this.ai.costMillicents(res.inputTokens, res.outputTokens, price),
      };
    } catch (e) {
      this.logger.warn(`Structuring page ${pageNumber} failed: ${(e as Error).message}`);
      return { data: null, inputTokens: 0, outputTokens: 0, millicents: 0 };
    }
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
      const res = await withAiTrace(
        { stage: model === this.config.primaryModel ? 'EXTRACT_PAGE' : 'EXTRACT_ESCALATION' },
        () =>
          this.ai.completeStructured<PageExtraction>({
            timeoutMs: this.config.ocrCallTimeoutMs,
            maxRetries: this.config.ocrCallRetries,
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
          }),
      );
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
