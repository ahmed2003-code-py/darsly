/**
 * The three-paper extraction benchmark.
 *
 *   npx ts-node --transpile-only scripts/ocr-bench/run.ts \
 *     --strategy baseline --out <dir> --p1 <jpg> --p2 <jpg> --p3 <jpg>
 *
 * Runs the real paper-extraction pipeline (PaperExtractionService, real
 * models, real prices) on the same stored page renders every time, records
 * every model call through AiCallLog, captures what each call was shown and
 * what it said, and scores the result against ground-truth.ts.
 *
 * Nothing here changes how the pipeline behaves; a strategy is only a set of
 * PaperImportConfig values (see STRATEGIES), which is how production would
 * switch it too.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AcademySiteConfig } from '../../src/academy-site/academy-site.config';
import { AiClient } from '../../src/academy-site/ai/ai.client';
import { withAiTrace } from '../../src/academy-site/ai/ai-trace';
import { PaperImportConfig } from '../../src/paper-import/paper-import.config';
import { PaperExtractionService } from '../../src/paper-import/paper-extraction.service';
import { ImageVariantsService } from '../../src/paper-import/ocr/image-variants.service';
import { TranscriberService } from '../../src/paper-import/ocr/transcriber.service';
import { AdaptiveReaderService } from '../../src/paper-import/ocr/adaptive-reader.service';
import { normalise } from '../../src/paper-import/ocr/reconcile';
import { scoreTranscription } from '../../src/paper-import/ocr/eval/metrics';
import { BenchPaper, ExpectedQuestion, PAPERS } from './ground-truth';

// ── strategies ─────────────────────────────────────────────────────────────

/** Config overrides per strategy. Anything not named keeps production's value. */
export const STRATEGIES: Record<string, Record<string, unknown>> = {
  baseline: {},
  'exp1-sol-medium': { fallbackEffort: 'medium' },
  adaptive: { extractionStrategy: 'adaptive', adaptiveBatch: false },
  'adaptive-batch': { extractionStrategy: 'adaptive', adaptiveBatch: true },
};

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

// ── scoring ────────────────────────────────────────────────────────────────

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** For comparison only: digits in one script, separators and punctuation gone. */
export function fold(text: string): string {
  return normalise(text ?? '')
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[٫٬٪%،,.:;؟?!()[\]{}«»"'`\-–—_/\\|]/g, ' ')
    .replace(/\[unclear\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function similarity(reference: string, got: string): number {
  const r = fold(reference);
  const g = fold(got);
  if (!r) return g ? 0 : 1;
  return Math.max(0, scoreTranscription(r, g).characterAccuracy);
}

interface Scored {
  expected: number;
  extracted: number;
  matched: number;
  recall: number;
  precision: number;
  transcription: number;
  numeric: number;
  numbering: number;
  options: number | null;
  perQuestion: {
    n: string;
    found: boolean;
    similarity: number;
    numeric: number;
    gotNumber: number | null;
    gotText: string;
  }[];
}

/** A question counts as recovered when its text is at least this close to the
 *  reference — enough that a teacher fixes words, not rewrites the question. */
const MATCH_AT = 0.6;

export function score(paper: BenchPaper, questions: any[]): Scored {
  const pool = questions.map((q, i) => ({ q, i, used: false }));
  const perQuestion: Scored['perQuestion'] = [];
  let optionHits = 0;
  let optionTotal = 0;
  for (const exp of paper.expected) {
    let best: { i: number; s: number } | null = null;
    for (const c of pool) {
      if (c.used) continue;
      const s = similarity(exp.text, c.q.text ?? '');
      if (!best || s > best.s) best = { i: c.i, s };
    }
    const hit = best && best.s >= MATCH_AT ? pool[best.i] : null;
    if (hit) hit.used = true;
    const q = hit?.q;
    if (exp.options) {
      optionTotal += exp.options.length;
      if (q) {
        const got = (q.options ?? []).map((o: any) => fold(o.text ?? ''));
        for (const o of exp.options)
          if (got.some((g: string) => g.endsWith(fold(o)) && fold(o))) optionHits++;
      }
    }
    perQuestion.push({
      n: exp.n,
      found: !!hit,
      similarity: best?.s ?? 0,
      numeric: q ? scoreTranscription(fold(exp.text), fold(q.text)).numericAccuracy : 0,
      gotNumber: q?.number ?? null,
      gotText: (q?.text ?? '').slice(0, 160),
    });
  }
  const matched = perQuestion.filter((p) => p.found);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    expected: paper.expected.length,
    extracted: questions.length,
    matched: matched.length,
    recall: paper.expected.length ? matched.length / paper.expected.length : 1,
    precision: questions.length ? matched.length / questions.length : paper.expected.length ? 0 : 1,
    transcription: mean(matched.map((p) => p.similarity)),
    numeric: mean(matched.map((p) => p.numeric)),
    numbering: matched.length
      ? matched.filter((p) => p.n && String(p.gotNumber ?? '') === p.n).length /
        Math.max(1, matched.filter((p) => p.n).length)
      : 0,
    options: optionTotal ? optionHits / optionTotal : null,
    perQuestion,
  };
}

// ── running ────────────────────────────────────────────────────────────────

async function main() {
  const strategy = arg('strategy', 'baseline')!;
  const overrides = STRATEGIES[strategy];
  if (!overrides)
    throw new Error(`Unknown strategy ${strategy}: ${Object.keys(STRATEGIES).join(', ')}`);
  const only = arg('only');
  const out = join(arg('out', '.')!, strategy);
  mkdirSync(out, { recursive: true });
  const images: Record<string, string | undefined> = {
    'p1-islamic-notes': arg('p1'),
    'p2-math-notes': arg('p2'),
    'p3-arithmetic-1927': arg('p3'),
  };

  const prisma = new PrismaClient();
  const config = new PaperImportConfig();
  Object.assign(config, overrides);
  const ai = new AiClient(new AcademySiteConfig(), prisma as never);
  const variants = new ImageVariantsService(config);
  const transcriber = new TranscriberService(ai, variants, config);
  const adaptive = new AdaptiveReaderService(ai, variants, config);
  const extraction = new PaperExtractionService(ai, config, transcriber, adaptive);
  const repeat = Math.max(1, Number(arg('repeat', '1')));

  const runId = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const report: any[] = [];

  for (let rep = 0; rep < repeat; rep++)
    for (const paper of PAPERS) {
      if (only && !paper.id.startsWith(only)) continue;
      const path = images[paper.id];
      if (!path) throw new Error(`No image for ${paper.id} (--${paper.id.slice(0, 2)})`);
      const importId = `bench:${strategy}:${runId}:${paper.id}:${rep}`;
      const dir = join(out, repeat > 1 ? `${paper.id}-r${rep}` : paper.id);
      mkdirSync(dir, { recursive: true });

      // What each look was shown and what it said — AiCallLog has the bill,
      // this has the content.
      const looks: any[] = [];
      const t = transcriber as any;
      const realRead = t.read.bind(t);
      t.read = async (imgs: any[], tier: string, instruction: string, tag: any) => {
        const n = looks.length;
        imgs.forEach((im, k) =>
          writeFileSync(join(dir, `call${n}-${tag.stage}-${k}.jpg`), im.data),
        );
        const started = Date.now();
        const res = await realRead(imgs, tier, instruction, tag);
        looks.push({
          n,
          stage: tag.stage,
          region: tag.region ?? null,
          attempt: tag.attempt ?? null,
          tier,
          images: imgs.map((im) => `${im.width}x${im.height}`),
          ms: Date.now() - started,
          millicents: res.millicents,
          error: res.error,
          regions: (res.data?.regions ?? []).map((r: any) => ({
            label: r.label,
            confidence: r.confidence,
            uncertain: (r.uncertain ?? []).length,
            text: r.text,
          })),
        });
        return res;
      };
      const ad = adaptive as any;
      const realCall = ad.call.bind(ad);
      ad.call = async (imgs: any[], rung: string, instruction: string, tag: any) => {
        const n = looks.length;
        looks.push(null);
        imgs.forEach((im, k) =>
          writeFileSync(join(dir, `call${n}-${tag.stage}-${rung}-${k}.jpg`), im.data),
        );
        const started = Date.now();
        const res = await realCall(imgs, rung, instruction, tag);
        looks[n] = {
          n,
          stage: tag.stage,
          region: tag.region ?? null,
          attempt: tag.attempt ?? null,
          tier: rung,
          images: imgs.map((im) => `${im.width}x${im.height}`),
          ms: Date.now() - started,
          millicents: res.millicents,
          error: res.error,
          regions: (res.data?.regions ?? []).map((r: any) => ({
            label: r.label,
            confidence: r.confidence,
            uncertain: (r.uncertain ?? []).length,
            text: r.text,
          })),
        };
        return res;
      };
      const realLocate = t.locate.bind(t);
      let boxes: any[] = [];
      t.locate = async (...a: any[]) => (boxes = await realLocate(...a));

      adaptive.lastRun = null;
      const started = Date.now();
      const image = readFileSync(path);
      const result = await withAiTrace({ importId, phase: 'BENCH' }, () =>
        extraction.extractPage({ pageNumber: 1, image }),
      );
      const ms = Date.now() - started;
      t.read = realRead;
      t.locate = realLocate;
      ad.call = realCall;
      await new Promise((r) => setTimeout(r, 1500)); // AiCallLog writes are fire-and-forget

      const calls = await prisma.aiCallLog.findMany({
        where: { importId },
        orderBy: { startedAt: 'asc' },
      });
      const questions = result.extraction?.questions ?? [];
      const s = score(paper, questions);
      const expensive = calls.filter((c) => c.model !== config.primaryModel);
      const row = {
        paper: paper.id,
        strategy,
        importId,
        ms,
        outcome: (result as any).outcome ?? null,
        calls: calls.length,
        expensiveCalls: expensive.length,
        costCents: calls.reduce((a, c) => a + c.costMillicents, 0) / 1000,
        expensiveCents: expensive.reduce((a, c) => a + c.costMillicents, 0) / 1000,
        inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0),
        outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0),
        reasoningTokens: calls.reduce((a, c) => a + c.reasoningTokens, 0),
        boxes: boxes.length,
        fabricated: s.extracted - s.matched,
        centsPerCorrect: s.matched
          ? calls.reduce((a, c) => a + c.costMillicents, 0) / 1000 / s.matched
          : null,
        highCalls: calls.filter((c) => c.reasoningEffort === 'high').length,
        pageRegions: looks.find((l) => l.stage === 'OCR_PAGE')?.regions.length ?? null,
        ...s,
      };
      report.push(row);
      writeFileSync(
        join(dir, 'detail.json'),
        JSON.stringify(
          { row, boxes, looks, adaptive: adaptive.lastRun, questions, calls },
          null,
          2,
        ),
      );
      console.log(
        `${paper.id.padEnd(20)} ${row.costCents.toFixed(2)}¢ calls=${row.calls} exp=${row.expensiveCalls} ` +
          `high=${row.highCalls} recall=${s.matched}/${s.expected} extracted=${s.extracted} fabricated=${row.fabricated} tx=${s.transcription.toFixed(2)} ` +
          `num=${s.numeric.toFixed(2)} ${(ms / 1000).toFixed(0)}s`,
      );
    }

  writeFileSync(join(out, `summary-${runId}.json`), JSON.stringify(report, null, 2));
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { ExpectedQuestion };
