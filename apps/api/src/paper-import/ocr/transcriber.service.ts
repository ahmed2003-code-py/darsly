import { Injectable, Logger } from '@nestjs/common';
import { AiClient, AiPrice, AiReasoningEffort } from '../../academy-site/ai/ai.client';
import { PaperImportConfig } from '../paper-import.config';
import { ImageVariantsService, RenderedImage } from './image-variants.service';
import { ANALYSIS_TARGET_WIDTH } from './image-analysis';
import { Band, mergeToCount, scaleBoxes, segment } from './segmentation';
import {
  PAGE_TRANSCRIPT_SCHEMA,
  PageTranscript,
  TRANSCRIBE_SYSTEM,
  TranscriptRegion,
  UNCLEAR,
  transcriptIsUsable,
} from './transcript.schema';
import { Candidate, applyFragment, looksNumeric, mergeRegion, reconcile } from './reconcile';

export interface TranscriptionCost {
  inputTokens: number;
  outputTokens: number;
  millicents: number;
  /** How many model calls this page took, which is the latency story. */
  calls: number;
  /** How many of them were crops rather than whole pages. */
  cropCalls: number;
  escalated: boolean;
}

export interface TranscriptionResult {
  transcript: PageTranscript | null;
  cost: TranscriptionCost;
  error: string | null;
  /** True when something is still unreadable after every pass, so the teacher
   *  is shown it rather than a confident-sounding guess. */
  needsReview: boolean;
}

/**
 * Reading a page, as several looks rather than one.
 *
 * The pipeline this replaces sent the whole page to one model once and asked
 * it for exam questions. Everything it got wrong on handwriting came from that
 * single decision: a whole A4 page inside the model's image budget is about
 * fifty pixels per line, and fifty pixels is not enough to tell ١٢٨ from ١٢٨٠
 * in faded ink at an angle.
 *
 * What happens instead:
 *
 *   1. The page is measured and only the repairs it needs are made.
 *   2. One pass reads the whole page and says, per region, how well it could.
 *   3. Regions it could not read are cropped **from the original** and read
 *      again. A crop of one question at the same image budget is several
 *      times the resolution — free magnification, spent where it is needed.
 *   4. Numbers flagged inside an otherwise-fine region get their own crop.
 *   5. Readings that disagree are reconciled on visual evidence, never on
 *      which one makes better arithmetic.
 *
 * A clean page costs exactly one call, same as before. A hard page costs a few
 * small ones instead of one large one on the flagship.
 */
@Injectable()
export class TranscriberService {
  private readonly logger = new Logger(TranscriberService.name);

  constructor(
    private readonly ai: AiClient,
    private readonly images: ImageVariantsService,
    private readonly config: PaperImportConfig,
  ) {}

  async transcribe(
    original: Buffer,
    opts: { pageNumber: number; tier?: 'AUTO' | 'STRONG' } = { pageNumber: 1 },
  ): Promise<TranscriptionResult> {
    const cost: TranscriptionCost = {
      inputTokens: 0,
      outputTokens: 0,
      millicents: 0,
      calls: 0,
      cropCalls: 0,
      escalated: false,
    };

    let prepared;
    try {
      prepared = await this.images.prepare(original);
    } catch (e) {
      return {
        transcript: null,
        cost,
        error: `Image could not be prepared: ${(e as Error).message}`.slice(0, 400),
        needsReview: true,
      };
    }

    const strong = opts.tier === 'STRONG';
    const images = [prepared.base, ...(prepared.enhanced ? [prepared.enhanced] : [])];

    // ── pass A: the whole page ────────────────────────────────────────────
    const pageCall = await this.read(
      images,
      strong ? 'strong' : 'primary',
      `Page ${opts.pageNumber}. Transcribe every region of it.` +
        (images.length > 1
          ? ' Two processed copies of the same page are attached; where they disagree, trust the one you can actually see.'
          : ''),
    );
    this.add(cost, pageCall);
    if (!pageCall.data) {
      return { transcript: null, cost, error: pageCall.error, needsReview: true };
    }

    let transcript = normalise(pageCall.data);
    if (!this.config.ocrMultiPass || transcript.blank) {
      return { transcript, cost, error: null, needsReview: this.needsReview(transcript) };
    }

    // Where the regions actually are on the page, so a re-read can be a crop
    // rather than another look at the same fifty pixels per line.
    const boxes = await this.locate(original, transcript.regions.length);

    // ── pass B: the regions it could not read ─────────────────────────────
    const ranked = transcript.regions
      .map((region, index) => ({ region, index }))
      .filter(({ region }) => region.confidence < this.config.ocrAcceptConfidence)
      .sort((a, b) => a.region.confidence - b.region.confidence);

    /**
     * Two ways to end up re-reading the whole page instead of cropping it.
     *
     * The first is that everything is doubtful: a page where every region is
     * below the bar is a bad page, not a good page with a bad question on it,
     * and eleven crops cost more than one better look.
     *
     * The second is that there is nothing to crop. A page the segmenter could
     * not divide has no boxes to aim at, and the first version of this simply
     * fell through both branches and did nothing at all — the worst outcome
     * available, since the reading was known to be poor and a whole-page
     * re-read was still on the table.
     */
    const nothingToCropButSomethingWrong = !boxes.length && ranked.length > 0;
    const tooMuchWrongToCrop = ranked.length > this.config.ocrMaxRegionCrops;
    if (!strong && (nothingToCropButSomethingWrong || (boxes.length && tooMuchWrongToCrop))) {
      const retry = await this.read(images, 'fallback', `Page ${opts.pageNumber}. Transcribe it.`);
      this.add(cost, retry);
      cost.escalated = true;
      if (retry.data && transcriptIsUsable(retry.data)) transcript = normalise(retry.data);
    } else {
      for (const { region, index } of ranked.slice(0, this.config.ocrMaxRegionCrops)) {
        const box = boxes[index];
        if (!box) continue;
        const resolved = await this.rereadRegion(original, box, region, cost, strong);
        transcript = mergeRegion(transcript, index, resolved);
      }
    }

    // ── pass C: the numbers ───────────────────────────────────────────────
    // Done after the regions, so a region that was re-read whole does not also
    // get its fragments cropped for nothing.
    for (let i = 0; i < transcript.regions.length; i++) {
      const region = transcript.regions[i];
      const box = boxes[i];
      if (!box) continue;
      const fragments = region.uncertain
        .filter((u) => u.numeric || looksNumeric(u.text))
        .slice(0, this.config.ocrMaxFragmentCrops);
      if (!fragments.length) continue;

      let updated = region;
      for (const fragment of fragments) {
        const resolution = await this.rereadFragment(original, box, fragment.text, cost);
        if (!resolution) continue;
        updated = applyFragment(updated, fragment, resolution);
      }
      transcript = mergeRegion(transcript, i, updated);
    }

    return { transcript, cost, error: null, needsReview: this.needsReview(transcript) };
  }

  // ── passes ───────────────────────────────────────────────────────────────

  /**
   * One question, cropped from the original and read again.
   *
   * The escalation that matters. It is cheaper than re-reading the page — a
   * crop is a smaller picture of a smaller thing — and it is the only step
   * that actually gives the model more pixels per stroke than it had.
   */
  private async rereadRegion(
    original: Buffer,
    box: Band,
    region: TranscriptRegion,
    cost: TranscriptionCost,
    strong: boolean,
  ): Promise<TranscriptRegion> {
    const candidates: Candidate[] = [
      { text: region.text, confidence: region.confidence, evidence: 'page' },
    ];
    let best = region;

    for (let pass = 0; pass < this.config.ocrMaxRegionPasses; pass++) {
      // The first re-read is on the same model at much higher resolution,
      // which is usually all it needed. Only a second failure buys a better
      // model, because a better model at the same resolution is the expensive
      // way to not solve this.
      const tier = pass === 0 ? (strong ? 'strong' : 'primary') : strong ? 'strong' : 'fallback';
      const crop = await this.images.crop(original, box, { upscale: true });
      const call = await this.read(
        [crop],
        tier,
        [
          region.label
            ? `This is question ${region.label} of an exam page.`
            : 'A region of a page.',
          'It is a close-up crop of one region, so read it carefully and completely.',
          'Return it as a single region.',
        ].join(' '),
      );
      this.add(cost, call);
      cost.cropCalls += 1;
      if (pass > 0) cost.escalated = true;
      if (!call.data?.regions?.length) continue;

      const read = normaliseRegion(call.data.regions[0], region.label);
      candidates.push({
        text: read.text,
        confidence: read.confidence,
        evidence: 'region',
      });
      best = read;
      if (read.confidence >= this.config.ocrAcceptConfidence) break;
    }

    const resolution = reconcile(candidates);
    return {
      ...best,
      label: best.label || region.label,
      text: resolution.unresolved ? best.text : resolution.text,
      confidence: resolution.confidence,
      // Anything the closer look still could not settle stays flagged rather
      // than being quietly accepted.
      uncertain: resolution.unresolved
        ? [
            ...best.uncertain,
            {
              text: resolution.text,
              confidence: resolution.confidence,
              reason: 'passes disagreed',
              numeric: looksNumeric(resolution.text),
            },
          ]
        : best.uncertain,
      math: best.math?.length ? best.math : region.math,
    };
  }

  /**
   * One number, looked at on its own.
   *
   * A digit is the highest-risk thing on an exam paper and the cheapest thing
   * to check: a crop of a line costs a few hundred image tokens. The prompt is
   * narrowed to reading characters, because the general instruction to
   * transcribe a region invites the model to think about the region.
   */
  private async rereadFragment(
    original: Buffer,
    box: Band,
    fragment: string,
    cost: TranscriptionCost,
  ) {
    const crop = await this.images.crop(original, box, { upscale: true });
    const call = await this.read(
      [crop],
      'primary',
      [
        `In this crop there is a number or quantity previously read as "${fragment}".`,
        'Find it and read the characters exactly as drawn.',
        'Report only what the strokes show. Do not adjust it to make any calculation work out, and do not convert between Arabic-Indic and Western digits.',
        'Return one region whose text is that number alone.',
      ].join(' '),
    );
    this.add(cost, call);
    cost.cropCalls += 1;
    const read = call.data?.regions?.[0];
    if (!read) return null;

    return reconcile([
      { text: fragment, confidence: 0.5, evidence: 'page' },
      { text: (read.text ?? '').trim(), confidence: read.confidence ?? 0.5, evidence: 'focus' },
    ]);
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  /** Where the regions are, measured from the page's own ink. Returns an
   *  empty list when the page did not divide convincingly, which is the
   *  signal to stop trying to crop it. */
  private async locate(original: Buffer, regionCount: number): Promise<Band[]> {
    try {
      const sharp = require('sharp');
      const meta = await sharp(original).rotate().metadata();
      const small = await sharp(original)
        .rotate()
        .greyscale()
        .resize({ width: Math.min(ANALYSIS_TARGET_WIDTH, meta.width ?? ANALYSIS_TARGET_WIDTH) })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const result = segment(new Uint8Array(small.data), small.info.width, small.info.height);
      if (!result.confident) return [];
      const factor = (meta.width ?? small.info.width) / small.info.width;
      const blocks = scaleBoxes(result.blocks, factor);

      /**
       * The model said how many regions it saw; the pixels said how many
       * bands there are, and they rarely agree exactly — a question written
       * over two paragraphs is two bands. On the real 1947 page, seven
       * questions came back as eleven.
       *
       * What matters is that crop four is aimed at question four, so extra
       * bands are merged down to the model's count. Merging only goes one
       * way: a page that produced FEWER bands than the model saw regions is
       * one where every crop would be aimed at the wrong thing, and it is
       * better to read it whole than to read the wrong sixth of it closely.
       */
      if (!regionCount) return blocks;
      if (blocks.length < regionCount) {
        this.logger.debug(
          `segmentation found ${blocks.length} bands for ${regionCount} regions — not cropping`,
        );
        return [];
      }
      return mergeToCount(blocks, regionCount);
    } catch (e) {
      this.logger.debug(`segmentation failed: ${(e as Error).message}`);
      return [];
    }
  }

  private async read(
    images: RenderedImage[],
    tier: 'primary' | 'fallback' | 'strong',
    instruction: string,
  ): Promise<{
    data: PageTranscript | null;
    error: string | null;
    tokens: [number, number];
    millicents: number;
  }> {
    const { model, price, effort } = this.tier(tier);
    try {
      const res = await this.ai.completeStructured<PageTranscript>({
        model,
        price,
        reasoningEffort: effort,
        maxTokens: this.config.maxTokens,
        imageDetail: this.config.imageDetail,
        system: TRANSCRIBE_SYSTEM,
        schemaName: 'page_transcript',
        schema: PAGE_TRANSCRIPT_SCHEMA as unknown as Record<string, unknown>,
        messages: [
          {
            role: 'user',
            content: instruction,
            images: images.map((i) => `data:image/jpeg;base64,${i.data.toString('base64')}`),
          },
        ],
      });
      return {
        data: res.data,
        error: null,
        tokens: [res.inputTokens, res.outputTokens],
        millicents: this.ai.costMillicents(res.inputTokens, res.outputTokens, price),
      };
    } catch (e) {
      const message = (e as Error).message ?? 'AI call failed';
      this.logger.warn(`transcription failed on ${model}: ${message}`);
      return { data: null, error: message.slice(0, 400), tokens: [0, 0], millicents: 0 };
    }
  }

  private tier(which: 'primary' | 'fallback' | 'strong'): {
    model: string;
    price: AiPrice;
    effort: AiReasoningEffort;
  } {
    if (which === 'strong') {
      return {
        model: this.config.strongModel,
        price: this.config.strongPrice,
        effort: this.config.strongEffort,
      };
    }
    if (which === 'fallback') {
      return {
        model: this.config.fallbackModel,
        price: this.config.fallbackPrice,
        effort: this.config.fallbackEffort,
      };
    }
    return {
      model: this.config.primaryModel,
      price: this.config.primaryPrice,
      effort: this.config.primaryEffort,
    };
  }

  private add(
    cost: TranscriptionCost,
    call: { tokens: [number, number]; millicents: number },
  ): void {
    cost.inputTokens += call.tokens[0];
    cost.outputTokens += call.tokens[1];
    cost.millicents += call.millicents;
    cost.calls += 1;
  }

  /** Anything left unreadable, or any region still below the bar, is the
   *  teacher's to look at — and is said so rather than hidden. */
  private needsReview(t: PageTranscript): boolean {
    if (t.blank) return false;
    return t.regions.some(
      (r) =>
        r.confidence < this.config.ocrVerifyConfidence ||
        (r.text ?? '').includes(UNCLEAR) ||
        r.uncertain.length > 0,
    );
  }
}

/** Defensive tidying of whatever came back, so nothing downstream has to
 *  wonder whether a field is there. */
function normalise(t: PageTranscript): PageTranscript {
  return {
    language: t.language ?? 'unknown',
    confidence: clamp(t.confidence),
    blank: !!t.blank,
    regions: Array.isArray(t.regions) ? t.regions.map((r) => normaliseRegion(r)) : [],
  };
}

function normaliseRegion(r: TranscriptRegion, fallbackLabel = ''): TranscriptRegion {
  return {
    label: (r?.label ?? '').trim() || fallbackLabel,
    text: (r?.text ?? '').trim(),
    confidence: clamp(r?.confidence),
    uncertain: Array.isArray(r?.uncertain)
      ? r.uncertain
          .filter((u) => (u?.text ?? '').trim())
          .map((u) => ({
            text: u.text.trim(),
            confidence: clamp(u.confidence),
            reason: (u.reason ?? '').trim(),
            numeric: !!u.numeric || looksNumeric(u.text),
          }))
      : [],
    math: Array.isArray(r?.math)
      ? r.math
          .filter((m) => (m?.raw ?? '').trim())
          .map((m) => ({ raw: m.raw.trim(), latex: (m.latex ?? '').trim() }))
      : [],
  };
}

function clamp(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(1, n));
}
