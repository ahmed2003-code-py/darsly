import { Injectable, Logger } from '@nestjs/common';
import { AiTrace, withAiTrace } from '../../academy-site/ai/ai-trace';
import { AiClient, AiPrice, AiReasoningEffort } from '../../academy-site/ai/ai.client';
import { PaperImportConfig } from '../paper-import.config';
import { Chunk, chunkLines, growToQuiet, isRuled, ruledLines, tiles } from './chunking';
import { estimateSkew, inkMask } from './image-analysis';
import { ImageVariantsService, RenderedImage } from './image-variants.service';
import { segment } from './segmentation';
import type { PagePhase, TranscriptionResult } from './transcriber.service';
import {
  PAGE_TRANSCRIPT_SCHEMA,
  PageTranscript,
  TRANSCRIBE_SYSTEM,
  TranscriptRegion,
  UNCLEAR,
} from './transcript.schema';
import {
  ChunkAssessment,
  assessChunk,
  numbering,
  questionMarkers,
  readableChars,
  grounding,
  unclearRatio,
} from './validation';

interface RunContext {
  /** Characters a line of this page's writing usually holds, from its clear crops. */
  expectedPerLine: number;
  /** Crops planned for the page, for the batched prompt. */
  planned: number;
}

/** Who reads, how hard. Named for why it is used, not for what it costs. */
type Rung = 'cheap' | 'reader' | 'recovery' | 'lastResort' | 'strong';

interface Reading {
  rung: Rung;
  variant: 'plain' | 'wide' | 'enhanced' | 'merged' | 'zoom';
  text: string;
  uncertain: TranscriptRegion['uncertain'];
  math: TranscriptRegion['math'];
  assessment: ChunkAssessment | null;
  error: string | null;
}

interface ChunkState {
  index: number;
  box: { left: number; top: number; width: number; height: number };
  /** Its lines, in the source's pixels, top to bottom. */
  members: { top: number; height: number }[];
  lines: number;
  why: string;
  readings: Reading[];
}

/** What one page's run looked like — for the log, the benchmark and tests. */
export interface AdaptiveRunRecord {
  pageNumber: number;
  skew: number;
  ruled: boolean;
  lineHeightPx: number;
  scale: number;
  reader: Rung;
  readerReason: string;
  chunks: {
    index: number;
    box: ChunkState['box'];
    lines: number;
    why: string;
    readings: Omit<Reading, 'uncertain' | 'math'>[];
    final: string;
  }[];
  escalations: Record<string, unknown>[];
  numbering: ReturnType<typeof numbering>;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Reading a page — the adaptive strategy (EXAM_EXTRACTION_STRATEGY=adaptive).
 *
 * What the benchmark showed about the current path, and what this does
 * instead:
 *
 *  - Its crops were cut to match how many regions the cheap model reported,
 *    and on handwriting the cheap model reported regions of pure [UNCLEAR].
 *    → Crops come from the page's own lines (chunking.ts). No model decides
 *      where a crop goes, so the same page is always cut the same way.
 *  - The cheap model then read every crop, found nothing — or invented an
 *    exam question at 0.74 confidence — and every crop went to the flagship
 *    tier at high effort: 93–97% of a page's cost.
 *    → One cheap look at the whole page decides whether the cheap model can
 *      read THIS page at all. If it cannot, it is not asked again; the
 *      capable model reads the crops at low effort.
 *  - Escalation followed the model's own confidence, which on those pages was
 *    inversely related to the truth.
 *    → Every crop is judged on measured evidence (validation.ts): empty or
 *      too short for the ink it holds is a crop problem and is recropped
 *      before anything costs more; too much [UNCLEAR] on a sound crop goes
 *      one rung up. Medium comes before high, and high only when a sound crop
 *      stayed ambiguous at medium. Each step is logged with its reason.
 *  - Numbering is checked across the page: a question number that should be
 *    there and is not is a structural gap, and the crops around it are read
 *    again together.
 *
 * It returns exactly what TranscriberService returns, so nothing downstream
 * knows which strategy read the page.
 */
@Injectable()
export class AdaptiveReaderService {
  private readonly logger = new Logger(AdaptiveReaderService.name);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  private readonly sharp = require('sharp');
  /** The most recent page's record. The benchmark reads it; nothing else. */
  lastRun: AdaptiveRunRecord | null = null;

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
    const cost = {
      inputTokens: 0,
      outputTokens: 0,
      millicents: 0,
      calls: 0,
      cropCalls: 0,
      escalated: false,
    };
    const escalations: Record<string, unknown>[] = [];
    const page = opts.pageNumber;
    // Per page, never on the service: several jobs read pages at once.
    const ctx: RunContext = { expectedPerLine: 0, planned: 0 };

    say({ phase: 'PREPARING' });
    let prepared;
    try {
      prepared = await this.images.prepare(original);
    } catch (e) {
      return this.failed(cost, `Image could not be prepared: ${(e as Error).message}`);
    }
    const visual = Math.max(
      0,
      Math.min(1, prepared.quality.sharpness * 0.5 + prepared.quality.contrast * 0.5),
    );

    // ── 1. one cheap look: is there anything, and can the cheap model read it
    say({ phase: 'READING' });
    const strong = opts.tier === 'STRONG';
    const probe = strong
      ? null
      : await this.call([prepared.base], 'cheap', `Page ${page}. Transcribe every region of it.`, {
          stage: 'OCR_PAGE',
          attempt: 0,
        });
    if (probe) this.add(cost, probe);
    const probeText = (probe?.data?.regions ?? []).map((r) => r.text ?? '').join('\n');
    if (probe?.data?.blank && readableChars(probeText) < 3) {
      return this.done(
        { language: probe.data.language ?? 'unknown', confidence: 1, blank: true, regions: [] },
        cost,
        visual,
        1,
        null,
      );
    }
    const probeUnclear = probe?.data ? unclearRatio(probeText) : 1;
    const cheapUsable =
      !!probe?.data &&
      probeUnclear <= this.config.adaptiveCheapUnclearMax &&
      readableChars(probeText) >= 20;
    const reader: Rung = strong ? 'strong' : cheapUsable ? 'cheap' : 'reader';
    const readerReason = strong
      ? 'teacher asked for the strongest reading'
      : !probe?.data
        ? `probe failed (${probe?.error?.slice(0, 80) ?? 'no data'})`
        : `probe unclear ${(probeUnclear * 100).toFixed(0)}% ${cheapUsable ? '≤' : '>'} ${(this.config.adaptiveCheapUnclearMax * 100).toFixed(0)}%`;
    this.logger.log(
      `READER_SELECTED page=${page} reader=${reader} (${this.describe(reader)}) — ${readerReason}`,
    );

    // ── 2. crops from the page's own lines ────────────────────────────────
    say({ phase: 'LOCATING' });
    const layout = await this.layout(original);
    const chunks: ChunkState[] = layout.chunks.map((c, index) => ({
      index,
      box: c.box,
      members: c.members,
      lines: c.lines,
      why: c.why,
      readings: [],
    }));
    this.logger.log(
      `CROP_PLAN page=${page} skew=${layout.skew}° ruled=${layout.ruled} lineH=${layout.lineHeightPx}px ` +
        `scale=${layout.scale.toFixed(2)} crops=${chunks.length}: ` +
        chunks.map((c) => `${c.box.top}+${c.box.height}(${c.lines}L,${c.why})`).join(' '),
    );
    if (!chunks.length) {
      return this.failed(cost, 'The page did not divide into anything to read');
    }
    ctx.planned = chunks.length;

    // ── 3. first reading, on the chosen reader ────────────────────────────
    say({ phase: 'REREADING', done: 0, total: chunks.length });
    await this.readAll(layout.source, layout.scale, chunks, reader, 'plain', page, cost, ctx);
    this.assessAll(chunks, ctx);

    // ── 4. recovery, cheapest first, each step for a stated reason ────────
    const failing = () => chunks.filter((c) => this.best(c).assessment?.verdict !== 'CLEAR');
    const note = (c: ChunkState, to: Rung, variant: string, why: string) => {
      const last = c.readings[c.readings.length - 1];
      const entry = {
        page,
        crop: c.index,
        box: c.box,
        reason: why,
        evidence: last?.assessment?.reasons ?? [],
        signals: last?.assessment?.signals ?? null,
        visual: Number(visual.toFixed(2)),
        attempts: c.readings.map((r) => `${r.rung}/${r.variant}`),
        next: `${this.describe(to)} ${variant}`,
      };
      escalations.push(entry);
      this.logger.log(`ADAPTIVE_ESCALATION ${JSON.stringify(entry)}`);
    };

    if (!strong) {
      // 4a. A crop problem is fixed on the crop, at the same price: wider
      //     context, and the enhanced rendering when the page is faint.
      const badCrops = failing().filter((c) => this.best(c).assessment?.verdict === 'BAD_CROP');
      if (badCrops.length) {
        const variant = visual < 0.55 ? 'enhanced' : 'wide';
        for (const c of badCrops)
          note(c, reader, variant, 'BAD_CROP: recrop before a dearer reader');
        await this.readAll(
          layout.source,
          layout.scale,
          badCrops,
          reader,
          variant,
          page,
          cost,
          ctx,
          layout,
        );
        this.assessAll(badCrops, ctx);
      }

      // 4b. Still failing on the cheap reader: the capable one, low effort.
      if (reader === 'cheap') {
        const up = failing();
        for (const c of up) note(c, 'reader', 'plain', 'cheap reader could not settle this crop');
        if (up.length) {
          await this.readAll(layout.source, layout.scale, up, 'reader', 'plain', page, cost, ctx);
          this.assessAll(up, ctx);
        }
      }

      // 4c. Widely unreadable on a sound crop (more than a fifth [UNCLEAR]):
      //     the whole crop at medium effort. A crop that is still "empty
      //     with ink" after a recrop and a capable reader is taken as having
      //     nothing to read (a smudge, a margin mark) — no rung above this
      //     reads pixels that are not text.
      const ambiguous = this.affordable(
        failing().filter((c) => this.best(c).assessment?.verdict === 'AMBIGUOUS'),
        'recovery',
        cost,
        page,
      );
      if (ambiguous.length) {
        for (const c of ambiguous) note(c, 'recovery', 'plain', 'AMBIGUOUS on a sound crop');
        await this.readAll(
          layout.source,
          layout.scale,
          ambiguous,
          'recovery',
          'plain',
          page,
          cost,
          ctx,
        );
        this.assessAll(ambiguous, ctx);
        cost.escalated = true;
      }

      // 4d. What is left unread is a word or a number here and there, and on
      //     an exam a number matters more than a paragraph. Each line still
      //     holding [UNCLEAR] is looked at alone, enlarged — first at low
      //     effort (the pixels are the fix), then medium, and high only for a
      //     line that a sound, enlarged crop at medium still could not settle.
      const ladder: Rung[] = ['reader', 'recovery'];
      if (this.config.adaptiveAllowHigh) ladder.push('lastResort');
      for (const rung of ladder) {
        const fixed = await this.zoomLines(layout, chunks, rung, page, cost, ctx, note);
        if (rung !== 'reader' && fixed.attempted) cost.escalated = true;
        if (fixed.remaining === 0) break;
      }
    }

    // ── 5. the page as a whole: numbering ─────────────────────────────────
    let fullText = chunks.map((c) => this.best(c).text).join('\n');
    let report = numbering(questionMarkers(fullText));
    if (!strong && report.numbered && report.missing.length) {
      // A number between two that were found: the question is probably split
      // across a crop boundary, or read as [UNCLEAR]. Read the crops around
      // the gap together, as one crop, once.
      const gapChunks = this.chunksAroundGaps(chunks, report.missing).slice(0, 2);
      for (const pair of gapChunks) {
        const [a, b] = pair;
        const merged: ChunkState = {
          index: a.index,
          box: {
            left: a.box.left,
            top: a.box.top,
            width: a.box.width,
            height: b.box.top + b.box.height - a.box.top,
          },
          members: [...a.members, ...b.members],
          lines: a.lines + b.lines,
          why: `merged ${a.index}+${b.index}`,
          readings: [],
        };
        note(
          a,
          'recovery',
          'merged',
          `STRUCTURAL_GAP: question(s) ${report.missing.join(',')} missing between crops ${a.index} and ${b.index}`,
        );
        await this.readAll(
          layout.source,
          layout.scale,
          [merged],
          'recovery',
          'plain',
          page,
          cost,
          ctx,
        );
        this.assessAll([merged], ctx);
        const got = numbering(questionMarkers(this.best(merged).text));
        const before = numbering(
          questionMarkers([this.best(a).text, this.best(b).text].join('\n')),
        );
        // Kept only if the joint reading holds more of the page's numbers.
        if (new Set(got.numbers).size > new Set(before.numbers).size) {
          a.readings.push({ ...this.best(merged), variant: 'merged' });
          a.box = merged.box;
          a.members = merged.members;
          a.lines = merged.lines;
          b.readings.push({ ...this.best(merged), text: '', variant: 'merged', assessment: null });
          (b as ChunkState & { absorbed?: boolean }).absorbed = true;
        }
      }
      fullText = chunks.map((c) => this.finalText(c)).join('\n');
      report = numbering(questionMarkers(fullText));
    }

    // ── 6. assemble ────────────────────────────────────────────────────────
    const regions: TranscriptRegion[] = [];
    let previousLast = '';
    for (const c of chunks) {
      if ((c as ChunkState & { absorbed?: boolean }).absorbed) continue;
      const best = this.best(c);
      let lines = best.text.split('\n');
      // Crops do not share a line by construction, but a line sitting on a
      // notebook rule is visible from both sides of it, and a reader may
      // transcribe it twice. The first line of a crop that says the same as
      // the last line of the one above — word for word, near enough — goes.
      const first = lines[0]?.trim() ?? '';
      if (
        previousLast &&
        first &&
        grounding(first, previousLast) >= 0.7 &&
        grounding(previousLast, first) >= 0.7
      ) {
        lines = lines.slice(1);
      }
      const text = lines.join('\n').trim();
      if (!text) continue;
      previousLast = lines[lines.length - 1]?.trim() ?? '';
      regions.push({
        label: '',
        text,
        confidence: Math.max(0, 1 - unclearRatio(text)),
        uncertain: best.uncertain,
        math: best.math,
      });
    }
    const transcript: PageTranscript = {
      language: (probe?.data?.language as PageTranscript['language']) ?? 'unknown',
      confidence: regions.length ? Math.min(...regions.map((r) => r.confidence)) : 0,
      blank: false,
      regions,
    };

    this.lastRun = {
      pageNumber: page,
      skew: layout.skew,
      ruled: layout.ruled,
      lineHeightPx: layout.lineHeightPx,
      scale: layout.scale,
      reader,
      readerReason,
      chunks: chunks.map((c) => ({
        index: c.index,
        box: c.box,
        lines: c.lines,
        why: c.why,
        readings: c.readings.map(({ uncertain: _u, math: _m, ...r }) => r),
        final: this.finalText(c),
      })),
      escalations,
      numbering: report,
    };
    const expensive = chunks.flatMap((c) => c.readings).filter((r) => r.rung !== 'cheap').length;
    this.logger.log(
      `PAGE_READ page=${page} crops=${chunks.length} calls=${cost.calls} ` +
        `capable-model crop reads=${expensive} high=${chunks.flatMap((c) => c.readings).filter((r) => r.rung === 'lastResort').length} ` +
        `numbers=[${[...new Set(report.numbers)].join(',')}] missing=[${report.missing.join(',')}] ` +
        `cost=${(cost.millicents / 1000).toFixed(2)}¢`,
    );
    return this.done(transcript, cost, visual, 1, report.missing.length ? report : null);
  }

  // ── layout ───────────────────────────────────────────────────────────────

  /**
   * Straighten, find the lines, cut the crops. Everything here is pixels; no
   * model is consulted. Crops are in the straightened image's coordinates,
   * and are cut from it, so a tilted photograph's crops follow its lines.
   */
  async layout(original: Buffer): Promise<{
    source: Buffer;
    skew: number;
    ruled: boolean;
    lineHeightPx: number;
    scale: number;
    chunks: {
      box: ChunkState['box'];
      members: ChunkState['members'];
      lines: number;
      why: string;
    }[];
  }> {
    const oriented: Buffer = await this.sharp(original).rotate().toBuffer();
    const analyse = async (img: Buffer) => {
      const meta = await this.sharp(img).metadata();
      const small = await this.sharp(img)
        .greyscale()
        .resize({ width: Math.min(520, meta.width ?? 520) })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { meta, small, raw: new Uint8Array(small.data) };
    };
    const first = await analyse(oriented);
    const skew = estimateSkew(first.raw, first.small.info.width, first.small.info.height, 6);
    const source: Buffer =
      Math.abs(skew) >= 0.4
        ? await this.sharp(oriented).rotate(-skew, { background: '#ffffff' }).toBuffer()
        : oriented;
    const { meta, small, raw } = source === oriented ? first : await analyse(source);
    const w = small.info.width;
    const h = small.info.height;
    const W = meta.width ?? w;
    const k = W / w;

    const seg = segment(raw, w, h);
    let lines = seg.lines;
    const ruled = isRuled(lines);
    const mask = inkMask(raw, w, h);
    const rowInk = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) n += mask[y * w + x];
      rowInk[y] = n;
    }
    if (ruled) {
      const ruleRows = new Set<number>();
      for (const r of lines) for (let y = r.top; y < r.top + r.height; y++) ruleRows.add(y);
      lines = ruledLines(lines, h, (top, bottom) => {
        let s = 0;
        for (let y = Math.floor(top); y < Math.ceil(bottom) && y < h; y++) {
          if (!ruleRows.has(y)) s += rowInk[y];
        }
        return s;
      });
    }
    const lineH = median(lines.map((l) => l.height)) || seg.textHeightPx * 2 || 10;
    let chunks: Chunk[] = chunkLines(lines, h, { maxLines: this.config.adaptiveMaxLinesPerChunk });
    if (!chunks.length) chunks = tiles(h, lineH, this.config.adaptiveMaxLinesPerChunk);
    // Ruled pages are left as cut: the rules themselves are ink, and growing
    // into them would swallow the next line.
    if (!ruled) {
      chunks = chunks.map((c) => ({ ...c, ...growToQuiet(c, rowInk, Math.round(lineH)) }));
    }

    const lineHeightPx = Math.round(lineH * k);
    // A line comes out `adaptiveLinePx` tall: enlarged when the photo is
    // small, reduced when it is large — never blown up to fill a budget.
    const scale = Math.max(
      0.5,
      Math.min(3, this.config.adaptiveLinePx / Math.max(1, lineHeightPx)),
    );
    return {
      source,
      skew,
      ruled,
      lineHeightPx,
      scale,
      chunks: chunks.map((c) => ({
        box: { left: 0, top: Math.round(c.top * k), width: W, height: Math.round(c.height * k) },
        members: c.members.map((m) => ({
          top: Math.round(m.top * k),
          height: Math.round(m.height * k),
        })),
        lines: c.lines,
        why: c.why,
      })),
    };
  }

  // ── reading ──────────────────────────────────────────────────────────────

  private async readAll(
    source: Buffer,
    scale: number,
    chunks: ChunkState[],
    rung: Rung,
    variant: Reading['variant'],
    page: number,
    cost: {
      inputTokens: number;
      outputTokens: number;
      millicents: number;
      calls: number;
      cropCalls: number;
    },
    ctx: RunContext,
    layout?: { lineHeightPx: number; source: Buffer },
  ): Promise<void> {
    const total = await this.pageCount(source);
    const render = async (c: ChunkState) => {
      let box = c.box;
      if (variant === 'wide' || variant === 'enhanced') {
        // One more line of context above and below: a crop that cut through
        // the first or last line is the commonest reason for a short reading.
        const extra = layout?.lineHeightPx ?? Math.round(c.box.height / Math.max(1, c.lines));
        const top = Math.max(0, c.box.top - extra);
        box = { ...c.box, top, height: Math.min(total - top, c.box.height + extra * 2) };
      }
      return this.images.cropAt(source, box, {
        scale: variant === 'wide' ? Math.min(3, scale * 1.4) : scale,
        enhance: variant === 'enhanced',
      });
    };

    const batch = this.config.adaptiveBatch && chunks.length > 1;
    const groups: ChunkState[][] = [];
    if (batch) {
      for (let i = 0; i < chunks.length; i += this.config.adaptiveBatchSize) {
        groups.push(chunks.slice(i, i + this.config.adaptiveBatchSize));
      }
    } else {
      for (const c of chunks) groups.push([c]);
    }

    const run = async (group: ChunkState[]) => {
      const crops = await Promise.all(group.map(render));
      const n = ctx.planned || group.length;
      const instruction =
        variant === 'zoom'
          ? [
              `One line from page ${page}, enlarged so it can be read exactly.`,
              'Transcribe exactly what is written on it, as ONE region.',
              'Numbers matter most: read every digit as it is drawn, in the script it is drawn in.',
              'Write a question number or option letter inside the text where it is printed, never only in the label.',
            ].join(' ')
          : group.length === 1
            ? [
                `Part ${group[0].index + 1} of page ${page}, cut from the page top to bottom.`,
                'Transcribe every line in it, in reading order, as ONE region.',
                'Keep question numbers, option letters and every figure exactly as written, inside the text where they are printed — never only in the label.',
                'Skip only fragments of a neighbouring line cut through at the very top or bottom edge.',
              ].join(' ')
            : [
                `These ${group.length} images are consecutive parts of page ${page}, top to bottom (parts ${group.map((c) => c.index + 1).join(', ')} of ${n}).`,
                `Return exactly ${group.length} regions, one per image, in the same order as the images, each labelled with its part number.`,
                'Each region is every line in that image, in reading order. Keep question numbers, option letters and every figure exactly as written.',
              ].join(' ');
      const tag: AiTrace = {
        stage: group.length === 1 ? 'OCR_REGION' : 'OCR_REGION_BATCH',
        region: group.map((c) => `c${c.index}`).join(','),
        attempt: group[0].readings.length,
        meta: { rung, variant, crops: group.length },
      };
      const res = await this.call(crops, rung, instruction, tag);
      this.add(cost, res);
      cost.cropCalls += 1;
      const regions = res.data?.regions ?? [];
      // A batched answer that does not line up one-to-one with its images
      // cannot be attributed safely; those crops are read one at a time.
      if (group.length > 1 && regions.length !== group.length) {
        this.logger.log(
          `BATCH_MISMATCH page=${page} asked=${group.length} got=${regions.length} — reading separately`,
        );
        for (const c of group) await run([c]);
        return;
      }
      group.forEach((c, i) => {
        const r = group.length === 1 ? this.joinRegions(regions) : regions[i];
        c.readings.push({
          rung,
          variant,
          text: (r?.text ?? '').trim(),
          uncertain: r?.uncertain ?? [],
          math: r?.math ?? [],
          assessment: null,
          error: res.error,
        });
      });
    };

    // A pool, like the current path: independent crops, read side by side.
    const queue = [...groups];
    const workers = Array.from(
      { length: Math.min(this.config.ocrConcurrency, queue.length) },
      async () => {
        for (let g = queue.shift(); g; g = queue.shift()) await run(g);
      },
    );
    await Promise.all(workers);
  }

  /**
   * One reading out of however many regions the model split a crop into.
   *
   * The transcript schema has a `label` for a question's number, and a model
   * reading one question will often move "(٢)" out of the text and into the
   * label — where the rest of this pipeline, which reads text, never sees it.
   * The first real crop lost three question numbers that way. A label the
   * text does not already contain is put back in front of it.
   */
  private joinRegions(regions: TranscriptRegion[]): TranscriptRegion | undefined {
    const withLabel = (r: TranscriptRegion) => {
      const label = (r.label ?? '').trim().replace(/^[([]|[)\]]$/g, '');
      const text = (r.text ?? '').trim();
      if (!label || text.replace(/\s/g, '').includes(label.replace(/\s/g, ''))) return text;
      return `(${label}) ${text}`;
    };
    if (!regions.length) return undefined;
    if (regions.length === 1) return { ...regions[0], text: withLabel(regions[0]) };
    return {
      label: '',
      text: regions.map(withLabel).join('\n'),
      confidence: Math.min(...regions.map((r) => r.confidence ?? 0)),
      uncertain: regions.flatMap((r) => r.uncertain ?? []),
      math: regions.flatMap((r) => r.math ?? []),
    };
  }

  /**
   * Look again, closely, at each line that still holds [UNCLEAR].
   *
   * A reading whose lines match its crop's lines one-for-one says which line
   * on the page each unread word is on, so that line alone is cropped — with
   * a little room above and below — enlarged, and read. The new line
   * replaces the old one only if it leaves less unread AND keeps the words
   * already read, so a zoomed crop that caught the wrong line cannot
   * overwrite a good one.
   */
  private async zoomLines(
    layout: { source: Buffer; scale: number; lineHeightPx: number },
    chunks: ChunkState[],
    rung: Rung,
    page: number,
    cost: TranscriptionResult['cost'],
    ctx: RunContext,
    note: (c: ChunkState, to: Rung, variant: string, why: string) => void,
  ): Promise<{ remaining: number; attempted: number }> {
    const unread = (t: string) => (t.match(/\[UNCLEAR\]/g) ?? []).length;
    const targets: { chunk: ChunkState; k: number; state: ChunkState; before: string }[] = [];
    // Above low effort, only what an exam cannot do without: a number the
    // reader itself classed as a number. A stray word or a teacher's pencil
    // note in the margin stays [UNCLEAR] and goes to review — on the
    // benchmark page, climbing for those cost 24¢ of a 35¢ page.
    const beyondLow = rung !== 'reader';
    for (const c of chunks) {
      if ((c as ChunkState & { absorbed?: boolean }).absorbed) continue;
      const best = this.best(c);
      const lines = best.text.split('\n');
      if (!lines.some((l) => unread(l))) continue;
      if (beyondLow && !best.uncertain.some((u) => u.numeric)) continue;
      if (lines.length !== c.members.length) {
        // A whole crop enlarged is a large image; it is worth a low-effort
        // look, never a dearer one.
        if (beyondLow) continue;
        // The reading's lines do not map onto the page's: the unit to look
        // at again is the whole crop, enlarged.
        if (targets.length < 12) {
          targets.push({
            chunk: c,
            k: -1,
            before: this.best(c).text,
            state: { ...c, readings: [], why: 'zoom-crop' },
          });
        }
        continue;
      }
      lines.forEach((l, k) => {
        if (!unread(l) || targets.length >= 12) return;
        // Only a line whose unread part is a number goes above low effort.
        if (beyondLow && !best.uncertain.some((u) => u.numeric && l.includes('[UNCLEAR]'))) return;
        const m = c.members[k];
        const pad = Math.round(layout.lineHeightPx * 0.35);
        targets.push({
          chunk: c,
          k,
          before: l,
          state: {
            index: c.index,
            box: {
              left: c.box.left,
              top: Math.max(0, m.top - pad),
              width: c.box.width,
              height: m.height + pad * 2,
            },
            members: [m],
            lines: 1,
            why: `zoom line ${k + 1}`,
            readings: [],
          },
        });
      });
    }
    if (!targets.length) return { remaining: 0, attempted: 0 };
    const skipped = targets.length;
    const allowed = this.affordable(targets, rung, cost, page);
    const deferred = skipped - allowed.length;
    targets.splice(0, targets.length, ...allowed);
    if (!targets.length) return { remaining: deferred, attempted: 0 };
    for (const t of targets) {
      note(
        t.chunk,
        rung,
        'zoom',
        `UNREAD_TEXT ${unread(t.before)} [UNCLEAR] on ${t.k < 0 ? 'the crop' : `line ${t.k + 1}`} — enlarged`,
      );
    }
    await this.readAll(
      layout.source,
      Math.min(3, layout.scale * 2),
      targets.map((t) => t.state),
      rung,
      'zoom',
      page,
      cost,
      ctx,
    );
    let remaining = 0;
    for (const t of targets) {
      const raw = t.state.readings[t.state.readings.length - 1]?.text ?? '';
      const got = (t.k < 0 ? raw : raw.replace(/\n+/g, ' ')).trim();
      const kept = t.before.split('[UNCLEAR]').join(' ');
      const better = !!got && unread(got) < unread(t.before) && grounding(kept, got) >= 0.5;
      if (!better) {
        remaining++;
        continue;
      }
      const base = this.best(t.chunk);
      const lines = base.text.split('\n');
      const text = t.k < 0 ? got : lines.map((l, i) => (i === t.k ? got : l)).join('\n');
      t.chunk.readings.push({ ...base, rung, variant: 'zoom', text, assessment: null });
      this.assessAll([t.chunk], ctx);
      if (unread(got)) remaining++;
    }
    return { remaining: remaining + deferred, attempted: targets.length };
  }

  /**
   * As many of `items` as the page's budget still pays for at this rung.
   *
   * Checked per call, not per rung: a rung that starts just under the budget
   * used to run every one of its calls, and a 10¢ budget ended at 15.6¢. The
   * price of a call is estimated from this page's own calls so far, scaled by
   * what more effort costs; low-effort reads are always allowed, because a
   * page that cannot afford those cannot be read at all.
   */
  private affordable<T>(
    items: T[],
    rung: Rung,
    cost: TranscriptionResult['cost'],
    page: number,
  ): T[] {
    if (!items.length || rung === 'reader' || rung === 'cheap' || rung === 'strong') return items;
    const perCall = cost.calls ? cost.millicents / cost.calls : 1000;
    const factor = rung === 'recovery' ? 2 : 4;
    const left = this.config.adaptivePageBudgetCents * 1000 - cost.millicents;
    const n = Math.max(0, Math.floor(left / (perCall * factor)));
    if (n < items.length) {
      this.logger.log(
        `BUDGET_STOP page=${page} spent=${(cost.millicents / 1000).toFixed(2)}¢ ` +
          `budget=${this.config.adaptivePageBudgetCents}¢ — ${this.describe(rung)} for ${n} of ${items.length}; the rest left for review`,
      );
    }
    return items.slice(0, n);
  }

  /** Judge every newest reading against what the page's clear crops say a
   *  line of this handwriting usually holds. */
  private assessAll(chunks: ChunkState[], ctx: RunContext): void {
    const perLine: number[] = [];
    for (const c of chunks) {
      const r = c.readings[c.readings.length - 1];
      if (r && readableChars(r.text) > 3 && unclearRatio(r.text) < 0.2) {
        perLine.push(readableChars(r.text) / Math.max(1, c.lines));
      }
    }
    // Learned from the page's own clear crops, once there are enough of them
    // to say what a line of this handwriting holds; kept for later passes.
    if (perLine.length >= 2) ctx.expectedPerLine = Math.max(ctx.expectedPerLine, median(perLine));
    const expected = ctx.expectedPerLine;
    for (const c of chunks) {
      const r = c.readings[c.readings.length - 1];
      if (!r) continue;
      r.assessment = r.error
        ? {
            verdict: 'AMBIGUOUS',
            reasons: [`CALL_FAILED ${r.error.slice(0, 80)}`],
            signals: {
              readableChars: 0,
              lines: c.lines,
              charsPerLine: 0,
              expectedCharsPerLine: expected,
              unclearRatio: 1,
            },
          }
        : assessChunk({ text: r.text, lines: c.lines, expectedCharsPerLine: expected });
    }
  }

  /** The reading to keep: a clear one if there is one, otherwise the one
   *  with most readable text and least [UNCLEAR]. */
  private best(c: ChunkState): Reading {
    const rs = c.readings.filter((r) => r.assessment);
    const clear = rs.filter((r) => r.assessment!.verdict === 'CLEAR');
    const pool = clear.length ? clear : rs.length ? rs : c.readings;
    return (
      [...pool].sort(
        (a, b) =>
          readableChars(b.text) * (1 - unclearRatio(b.text)) -
          readableChars(a.text) * (1 - unclearRatio(a.text)),
      )[0] ?? {
        rung: 'cheap',
        variant: 'plain',
        text: '',
        uncertain: [],
        math: [],
        assessment: null,
        error: null,
      }
    );
  }

  private finalText(c: ChunkState): string {
    return (c as ChunkState & { absorbed?: boolean }).absorbed ? '' : this.best(c).text;
  }

  /** For each missing number, the pair of neighbouring crops it most likely
   *  fell between: the crop holding the number before it and the next one. */
  private chunksAroundGaps(chunks: ChunkState[], missing: number[]): [ChunkState, ChunkState][] {
    const out: [ChunkState, ChunkState][] = [];
    for (const m of missing) {
      const i = chunks.findIndex((c) => questionMarkers(this.best(c).text).includes(m - 1));
      if (i >= 0 && i < chunks.length - 1 && !out.some(([a]) => a === chunks[i])) {
        out.push([chunks[i], chunks[i + 1]]);
      }
    }
    return out;
  }

  private async pageCount(source: Buffer): Promise<number> {
    const m = await this.sharp(source).metadata();
    return m.height ?? 0;
  }

  // ── calls ────────────────────────────────────────────────────────────────

  private rung(r: Rung): { model: string; price: AiPrice; effort: AiReasoningEffort } {
    const c = this.config;
    switch (r) {
      case 'cheap':
        return { model: c.primaryModel, price: c.primaryPrice, effort: c.primaryEffort };
      case 'reader':
        return { model: c.fallbackModel, price: c.fallbackPrice, effort: c.adaptiveReaderEffort };
      case 'recovery':
        return { model: c.fallbackModel, price: c.fallbackPrice, effort: c.adaptiveRecoveryEffort };
      case 'lastResort':
        return {
          model: c.fallbackModel,
          price: c.fallbackPrice,
          effort: c.adaptiveLastResortEffort,
        };
      case 'strong':
        return { model: c.strongModel, price: c.strongPrice, effort: c.strongEffort };
    }
  }

  private describe(r: Rung): string {
    const { model, effort } = this.rung(r);
    return `${model}/${effort}`;
  }

  private async call(
    images: RenderedImage[],
    rung: Rung,
    instruction: string,
    tag: AiTrace,
  ): Promise<{
    data: PageTranscript | null;
    error: string | null;
    tokens: [number, number];
    millicents: number;
  }> {
    const { model, price, effort } = this.rung(rung);
    try {
      const res = await withAiTrace({ ...tag, meta: { ...(tag.meta ?? {}), rung } }, () =>
        this.ai.completeStructured<PageTranscript>({
          timeoutMs: this.config.ocrCallTimeoutMs,
          maxRetries: this.config.ocrCallRetries,
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
        }),
      );
      return {
        data: res.data,
        error: null,
        tokens: [res.inputTokens, res.outputTokens],
        millicents: this.ai.costMillicents(res.inputTokens, res.outputTokens, price),
      };
    } catch (e) {
      const message = (e as Error).message ?? 'AI call failed';
      this.logger.warn(`adaptive read failed on ${model}/${effort}: ${message}`);
      return { data: null, error: message.slice(0, 400), tokens: [0, 0], millicents: 0 };
    }
  }

  private add(
    cost: { inputTokens: number; outputTokens: number; millicents: number; calls: number },
    call: { tokens: [number, number]; millicents: number },
  ): void {
    cost.inputTokens += call.tokens[0];
    cost.outputTokens += call.tokens[1];
    cost.millicents += call.millicents;
    cost.calls += 1;
  }

  // ── outcome ──────────────────────────────────────────────────────────────

  private failed(cost: TranscriptionResult['cost'], error: string): TranscriptionResult {
    return {
      transcript: null,
      cost,
      error: error.slice(0, 400),
      needsReview: true,
      outcome: 'PROVIDER_ERROR',
      confidence: { visual: 0, segmentation: 0, transcription: 0, overall: 0 },
    };
  }

  private done(
    transcript: PageTranscript,
    cost: TranscriptionResult['cost'],
    visual: number,
    segmentation: number,
    structuralGap: ReturnType<typeof numbering> | null,
  ): TranscriptionResult {
    const readable = transcript.regions.filter((r) => readableChars(r.text) > 4);
    const unclearAnywhere = transcript.regions.some((r) => (r.text ?? '').includes(UNCLEAR));
    // Measured, not self-reported: the share of the page that was read.
    const transcription = transcript.blank
      ? 1
      : readable.length
        ? 1 - unclearRatio(transcript.regions.map((r) => r.text).join('\n'))
        : 0;
    const needsReview = !transcript.blank && (unclearAnywhere || !!structuralGap);
    const outcome: TranscriptionResult['outcome'] = transcript.blank
      ? 'NO_TEXT'
      : !readable.length
        ? 'LOW_CONFIDENCE'
        : needsReview
          ? 'PARTIAL_SUCCESS'
          : 'SUCCESS';
    return {
      transcript,
      cost,
      error: null,
      needsReview,
      outcome,
      confidence: {
        visual,
        segmentation,
        transcription,
        overall: Math.min(visual, transcription || 0, segmentation || 1),
      },
    };
  }
}
