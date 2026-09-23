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

/**
 * How reading a page ended, in the system's own words.
 *
 * Everything used to arrive downstream as "no questions", which reached the
 * teacher as «مفيش حاجة مقروءة طلعت من الصفحات دي» — a sentence that says the
 * page is blank. Production produced it for a page that was read fine and then
 * lost to a provider returning half a JSON document. Telling someone their
 * handwriting is illegible when in fact our request was cut off is worse than
 * telling them nothing.
 */
export type TranscriptionOutcome =
  /** The page really has nothing readable on it. */
  | 'NO_TEXT'
  /** Read, and good enough to use as it stands. */
  | 'SUCCESS'
  /** Read, with parts the teacher needs to look at. */
  | 'PARTIAL_SUCCESS'
  /** Read, but nothing came back above the bar. */
  | 'LOW_CONFIDENCE'
  /** The page could not be divided, so no crop could be aimed anywhere. */
  | 'SEGMENTATION_FAILED'
  /** The provider answered, but not with the shape it was asked for. */
  | 'STRUCTURED_OUTPUT_FAILED'
  /** The provider did not answer. */
  | 'PROVIDER_ERROR';

/**
 * Confidence, kept apart by what it is about.
 *
 * One number was doing four jobs. Production reported 0.16 for a page whose
 * real problem was a malformed provider response — the image was fine, the
 * segmentation was fine, and 0.16 described neither.
 */
export interface TranscriptionConfidence {
  /** From the pixels: focus, ink separation, lighting. No model involved. */
  visual: number;
  /** Whether the page divided into something crops could be aimed at. */
  segmentation: number;
  /** What the model said about its own reading. */
  transcription: number;
  /** The lowest of the above, which is what a teacher is really being told. */
  overall: number;
}

export interface TranscriptionResult {
  transcript: PageTranscript | null;
  cost: TranscriptionCost;
  error: string | null;
  /** True when something is still unreadable after every pass, so the teacher
   *  is shown it rather than a confident-sounding guess. */
  needsReview: boolean;
  outcome: TranscriptionOutcome;
  confidence: TranscriptionConfidence;
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
/**
 * What the reader is doing to a page right now, for the screen a teacher
 * watches. Each one is said when the work starts, never on a timer.
 */
export type PagePhase =
  | { phase: 'PREPARING' }
  | { phase: 'READING' }
  | { phase: 'LOCATING' }
  | { phase: 'REREADING'; done: number; total: number }
  | { phase: 'CHECKING_NUMBERS' };

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
    opts: {
      pageNumber: number;
      tier?: 'AUTO' | 'STRONG';
      /** Told as each step starts. Never awaited: a slow write about progress
       *  must not become slower progress. */
      onPhase?: (phase: PagePhase) => void;
    } = { pageNumber: 1 },
  ): Promise<TranscriptionResult> {
    const say = (phase: PagePhase) => {
      try {
        opts.onPhase?.(phase);
      } catch {
        // Reporting is never a reason for reading to fail.
      }
    };
    const cost: TranscriptionCost = {
      inputTokens: 0,
      outputTokens: 0,
      millicents: 0,
      calls: 0,
      cropCalls: 0,
      escalated: false,
    };

    let prepared;
    say({ phase: 'PREPARING' });
    try {
      prepared = await this.images.prepare(original);
    } catch (e) {
      return {
        transcript: null,
        cost,
        error: `Image could not be prepared: ${(e as Error).message}`.slice(0, 400),
        needsReview: true,
        outcome: 'PROVIDER_ERROR',
        confidence: { visual: 0, segmentation: 0, transcription: 0, overall: 0 },
      };
    }

    // From the pixels alone, before any model has seen it. A page that scores
    // well here and badly below has a provider problem, not a legibility one.
    const visual = Math.max(
      0,
      Math.min(1, prepared.quality.sharpness * 0.5 + prepared.quality.contrast * 0.5),
    );

    const strong = opts.tier === 'STRONG';
    const images = [prepared.base, ...(prepared.enhanced ? [prepared.enhanced] : [])];
    const trace = (line: string) => this.logger.debug(`[p${opts.pageNumber}] ${line}`);
    /**
     * Stop asking a tier that has stopped answering.
     *
     * Once the crop loop was fixed, a provider returning malformed output was
     * asked six more times on the same page — once per region — and failed
     * every time. Two strikes is enough to conclude the problem is the tier
     * and not the crop, and the cheap tier's reading is kept instead.
     */
    const failures = new Map<string, number>();
    const broken = (tier: string) => (failures.get(tier) ?? 0) >= 2;
    const noteFailure = (tier: string) => failures.set(tier, (failures.get(tier) ?? 0) + 1);
    trace(
      `IMAGE_ANALYSIS ${prepared.quality.width}x${prepared.quality.height} ` +
        `sharp=${prepared.quality.sharpness.toFixed(2)} sep=${prepared.quality.contrast.toFixed(2)} ` +
        `light=${prepared.quality.lighting.toFixed(2)} skew=${prepared.quality.skewDegrees} ` +
        `textH=${prepared.quality.textHeightPx}`,
    );
    trace(
      `PREPROCESS_COMPLETE variants=${images.length} base=${prepared.base.width}x${prepared.base.height}`,
    );

    // ── pass A: the whole page ────────────────────────────────────────────
    say({ phase: 'READING' });
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
      const malformed = (pageCall.error ?? '').includes('not valid JSON');
      return {
        transcript: null,
        cost,
        error: pageCall.error,
        needsReview: true,
        outcome: malformed ? 'STRUCTURED_OUTPUT_FAILED' : 'PROVIDER_ERROR',
        confidence: { visual, segmentation: 0, transcription: 0, overall: 0 },
      };
    }

    let transcript = normalise(pageCall.data);
    trace(
      `PAGE_PASS regions=${transcript.regions.length} confidence=${transcript.confidence.toFixed(2)}`,
    );
    if (!this.config.ocrMultiPass || transcript.blank) {
      return this.finish(transcript, cost, visual, 1, trace);
    }

    // Where the regions actually are on the page, so a re-read can be a crop
    // rather than another look at the same fifty pixels per line.
    say({ phase: 'LOCATING' });
    const boxes = await this.locate(original, transcript.regions.length, trace);
    trace(`SEGMENTATION_RESULT boxes=${boxes.length} forRegions=${transcript.regions.length}`);

    // ── pass B: the regions it could not read ─────────────────────────────
    const ranked = transcript.regions
      .map((region, index) => ({ region, index }))
      .filter(({ region }) => region.confidence < this.config.ocrAcceptConfidence)
      .sort((a, b) => a.region.confidence - b.region.confidence);
    trace(
      `TRIAGE below=${ranked.length}/${transcript.regions.length} ` +
        `accept=${this.config.ocrAcceptConfidence} maxCrops=${this.config.ocrMaxRegionCrops}`,
    );

    /**
     * Crop if there is anything to crop at. Re-read the page only if there is
     * not.
     *
     * This was backwards, and production found it on the first real page. The
     * cap on how many regions may be cropped was written as a condition for
     * cropping AT ALL, so a page where every question was doubtful — the exact
     * page crops exist for — had its seven ready boxes thrown away in favour
     * of one more look at the whole sheet at the same resolution that had
     * already failed. The log said `boxes=7` and `0 crop` in the same breath.
     *
     * The cap now does what it was named for: it limits how many crops, worst
     * region first. A crop is a smaller picture than the page it came from, so
     * six of them is not obviously dearer than one page re-read, and they are
     * the only thing in the pipeline that gives the model pixels it did not
     * already have.
     */
    if (boxes.length) {
      const crops = ranked
        .slice(0, this.config.ocrMaxRegionCrops)
        .filter(({ index }) => boxes[index]);
      let cropped = 0;
      for (const { region, index } of crops) {
        const box = boxes[index];
        if (!box) continue;
        say({ phase: 'REREADING', done: cropped++, total: crops.length });
        trace(
          `CROP_CREATED id=q${index + 1} bbox=${box.left},${box.top},${box.width}x${box.height}`,
        );
        const resolved = await this.rereadRegion(
          original,
          box,
          region,
          cost,
          strong,
          trace,
          index,
          {
            broken,
            noteFailure,
          },
        );
        transcript = mergeRegion(transcript, index, resolved);
      }
    } else if (ranked.length && !strong && !broken('fallback')) {
      // Nothing to aim a crop at, and the reading is known to be poor: one
      // more look at the whole page is all that is left.
      trace('NO_BOXES re-reading whole page on fallback');
      say({ phase: 'REREADING', done: 0, total: 1 });
      const retry = await this.read(images, 'fallback', `Page ${opts.pageNumber}. Transcribe it.`);
      this.add(cost, retry);
      cost.escalated = true;
      if (retry.data && transcriptIsUsable(retry.data)) transcript = normalise(retry.data);
      else noteFailure('fallback');
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

      say({ phase: 'CHECKING_NUMBERS' });
      let updated = region;
      for (const fragment of fragments) {
        const resolution = await this.rereadFragment(original, box, fragment.text, cost);
        if (!resolution) continue;
        updated = applyFragment(updated, fragment, resolution);
      }
      transcript = mergeRegion(transcript, i, updated);
    }

    return this.finish(transcript, cost, visual, boxes.length ? 1 : 0, trace);
  }

  /** One place that decides what happened, so the states cannot drift apart
   *  from the numbers that justify them. */
  private finish(
    transcript: PageTranscript,
    cost: TranscriptionCost,
    visual: number,
    segmentation: number,
    trace: (line: string) => void,
  ): TranscriptionResult {
    const needsReview = this.needsReview(transcript);
    const readable = transcript.regions.filter(
      (r) => (r.text ?? '').replace(UNCLEAR, '').trim().length > 4,
    );
    const transcription = transcript.blank
      ? 1
      : readable.length
        ? Math.max(...transcript.regions.map((r) => r.confidence))
        : 0;

    const outcome: TranscriptionOutcome = transcript.blank
      ? 'NO_TEXT'
      : !readable.length
        ? 'LOW_CONFIDENCE'
        : !segmentation && needsReview
          ? 'SEGMENTATION_FAILED'
          : needsReview
            ? 'PARTIAL_SUCCESS'
            : 'SUCCESS';

    const confidence = {
      visual,
      segmentation,
      transcription,
      overall: Math.min(visual, transcription || 0, segmentation || 1),
    };
    trace(
      `PAGE_DONE outcome=${outcome} visual=${visual.toFixed(2)} seg=${segmentation} ` +
        `transcription=${transcription.toFixed(2)} calls=${cost.calls} crops=${cost.cropCalls}`,
    );
    return { transcript, cost, error: null, needsReview, outcome, confidence };
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
    trace: (line: string) => void = () => undefined,
    index = 0,
    circuit: { broken: (t: string) => boolean; noteFailure: (t: string) => void } = {
      broken: () => false,
      noteFailure: () => undefined,
    },
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
      // A tier that has already failed twice on this page is not going to
      // answer for this region either, and asking is six more calls for
      // nothing — which is exactly what happened the first time crops ran.
      if (circuit.broken(tier)) {
        trace(`SKIP region=q${index + 1} pass=${pass} tier=${tier} (tier failing on this page)`);
        break;
      }
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
      trace(
        `TRANSCRIPTION_RESULT region=q${index + 1} pass=${pass} tier=${tier} ` +
          `ok=${!!call.data} confidence=${call.data?.regions?.[0]?.confidence ?? 'n/a'}` +
          (call.error ? ` error="${call.error.slice(0, 80)}"` : ''),
      );
      if (!call.data?.regions?.length) {
        if (call.error) circuit.noteFailure(tier);
        continue;
      }

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
  private async locate(
    original: Buffer,
    regionCount: number,
    trace: (line: string) => void = () => undefined,
  ): Promise<Band[]> {
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
      trace(
        `SEGMENTATION bands=${result.blocks.length} lines=${result.lines.length} ` +
          `confident=${result.confident} textH=${result.textHeightPx}`,
      );
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
        maxTokens: this.config.ocrMaxTokens,
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
