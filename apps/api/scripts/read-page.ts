/**
 * Read one exam page with the real models — `npm run page:read -- <image> [--runs N]`.
 *
 * The part of the studio no unit test can prove: how long a real page takes,
 * how many calls it costs, and whether what comes back is what is written on
 * the paper. It runs the same path an upload does — the page is normalised
 * exactly as it is when stored, then read by the same services with the same
 * settings — and prints, for each run:
 *
 *   - every step with its time since the start (the pipeline's own trace),
 *   - the number of model calls, crops, tokens and cost,
 *   - the questions it produced, in full, to compare against the paper.
 *
 * Settings come from the environment like the server's, so a change can be
 * measured before it ships: `PAPER_IMPORT_OCR_CONCURRENCY=1` for the old
 * one-after-another behaviour, for instance.
 *
 * Needs OPENAI_API_KEY and AI_ACADEMY_ENABLED=true (read from apps/api/.env).
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { AcademySiteConfig } from '../src/academy-site/academy-site.config';
import { AiClient } from '../src/academy-site/ai/ai.client';
import { PagePreparerService } from '../src/paper-import/page-preparer.service';
import { PaperExtractionService, ReadPhase } from '../src/paper-import/paper-extraction.service';
import { PaperImportConfig } from '../src/paper-import/paper-import.config';
import { ImageVariantsService } from '../src/paper-import/ocr/image-variants.service';
import { TranscriberService } from '../src/paper-import/ocr/transcriber.service';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const runsAt = args.indexOf('--runs');
const runs = runsAt >= 0 ? Math.max(1, Number(args[runsAt + 1]) || 1) : 1;
if (!file) {
  console.error('usage: npm run page:read -- <image> [--runs N]');
  process.exit(1);
}

// The pipeline traces through Nest's logger at debug level; show it, stamped
// with seconds since the run began, so the slow step is visible by eye.
let t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
Logger.overrideLogger({
  log: (m: unknown) => console.log(`${since()}  ${m}`),
  debug: (m: unknown) => console.log(`${since()}  ${m}`),
  warn: (m: unknown) => console.log(`${since()}  WARN ${m}`),
  error: (m: unknown) => console.log(`${since()}  ERROR ${m}`),
  verbose: () => undefined,
});

async function main() {
  const config = new PaperImportConfig();
  const ai = new AiClient(new AcademySiteConfig());
  const extraction = new PaperExtractionService(
    ai,
    config,
    new TranscriberService(ai, new ImageVariantsService(config), config),
  );
  const prepared = await new PagePreparerService(config).normalizeImage(readFileSync(file!));
  console.log(
    `page ${prepared.width}x${prepared.height}, ${Math.round(prepared.data.length / 1024)} KB · ` +
      `models ${config.primaryModel} / ${config.fallbackModel} · concurrency ${config.ocrConcurrency} · ` +
      `call timeout ${config.ocrCallTimeoutMs / 1000}s`,
  );

  const times: number[] = [];
  for (let run = 1; run <= runs; run++) {
    console.log(`\n══ run ${run}/${runs} ══════════════════════════════════════════`);
    t0 = Date.now();
    const onPhase = (p: ReadPhase) =>
      console.log(`${since()}  ▸ ${p.phase}${'total' in p ? ` ${p.done}/${p.total}` : ''}`);
    const result = await extraction.extractPage({
      pageNumber: 1,
      image: prepared.data,
      text: null,
      onPhase,
    });
    const seconds = (Date.now() - t0) / 1000;
    times.push(seconds);

    console.log(`\n── result: ${seconds.toFixed(1)}s ──`);
    console.log(
      `outcome=${result.outcome ?? 'ok'} escalated=${result.escalated} model=${result.model} ` +
        `tokens=${result.inputTokens}+${result.outputTokens} cost=${(result.millicents / 1000).toFixed(2)}¢`,
    );
    if (result.error) console.log(`error: ${result.error}`);
    const questions = result.extraction?.questions ?? [];
    console.log(`${questions.length} question(s):`);
    for (const q of questions) {
      console.log(`\n  [${q.number ?? '?'}] (${q.type}) ${q.text}`);
      for (const o of q.options ?? []) console.log(`       ${o.label ?? '-'}) ${o.text}`);
      if (q.lowConfidence) console.log('       ⚠ low confidence');
    }
  }
  if (runs > 1) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `\nruns: ${times.map((s) => s.toFixed(1)).join('s, ')}s · average ${avg.toFixed(1)}s`,
    );
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
