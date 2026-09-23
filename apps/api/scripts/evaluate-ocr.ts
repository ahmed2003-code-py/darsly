/**
 * Measure the transcription pipeline against a real provider.
 *
 * Not a test, and deliberately not: it spends money, it needs a key, and its
 * numbers move when the provider does. The automated suite measures everything
 * deterministic — the analysis, the segmentation, the reconciliation, the
 * metrics themselves — and stops exactly where the model begins. This is what
 * measures the rest.
 *
 *   OPENAI_API_KEY=sk-... npx ts-node --transpile-only scripts/evaluate-ocr.ts
 *   OPENAI_API_KEY=sk-... npx ts-node --transpile-only scripts/evaluate-ocr.ts --only=handwriting-faded
 *   ... --pages=/path/to/a/real/scan.jpg --reference=/path/to/its/text.txt
 *
 * A real scan with a hand-typed reference beside it is worth more than every
 * rendered fixture here; the fixtures exist so there is something to run on a
 * machine that has neither.
 */
import { promises as fs } from 'fs';
import { AiClient } from '../src/academy-site/ai/ai.client';
import { AcademySiteConfig } from '../src/academy-site/academy-site.config';
import { PaperImportConfig } from '../src/paper-import/paper-import.config';
import { ImageVariantsService } from '../src/paper-import/ocr/image-variants.service';
import { TranscriberService } from '../src/paper-import/ocr/transcriber.service';
import { FIXTURES, renderFixture } from '../src/paper-import/ocr/eval/fixtures';
import {
  AccuracyReport,
  confidenceCalibration,
  scoreTranscription,
  segmentationAccuracy,
} from '../src/paper-import/ocr/eval/metrics';

type Row = {
  id: string;
  challenge: string;
  score: AccuracyReport;
  segmentation: number;
  confidence: number;
  calls: number;
  cropCalls: number;
  millicents: number;
  ms: number;
};

async function main() {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'] as const;
    }),
  );
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY is required — this script calls a real provider and costs money.',
    );
    process.exit(1);
  }
  process.env.AI_ACADEMY_ENABLED = 'true';

  const config = new PaperImportConfig();
  const images = new ImageVariantsService(config);
  const transcriber = new TranscriberService(new AiClient(new AcademySiteConfig()), images, config);

  const cases: {
    id: string;
    challenge: string;
    image: Buffer;
    reference: string;
    regions: number;
  }[] = [];

  if (args.has('pages')) {
    const image = await fs.readFile(args.get('pages')!);
    const reference = args.has('reference')
      ? await fs.readFile(args.get('reference')!, 'utf8')
      : '';
    cases.push({ id: 'supplied', challenge: 'real', image, reference, regions: 0 });
  } else {
    const only = args.get('only');
    for (const f of FIXTURES) {
      if (only && f.id !== only) continue;
      cases.push({
        id: f.id,
        challenge: f.challenge,
        image: await renderFixture(f.render),
        reference: f.reference,
        regions: f.regions,
      });
    }
  }

  const rows: Row[] = [];
  for (const c of cases) {
    const started = Date.now();
    const out = await transcriber.transcribe(c.image, { pageNumber: 1 });
    const ms = Date.now() - started;
    const text = (out.transcript?.regions ?? [])
      .map((r) => [r.label, r.text].filter(Boolean).join(' '))
      .join('\n');

    rows.push({
      id: c.id,
      challenge: c.challenge,
      score: scoreTranscription(c.reference, text),
      segmentation: c.regions
        ? segmentationAccuracy(c.regions, out.transcript?.regions.length ?? 0)
        : 1,
      confidence: out.transcript?.confidence ?? 0,
      calls: out.cost.calls,
      cropCalls: out.cost.cropCalls,
      millicents: out.cost.millicents,
      ms,
    });
    if (c.reference) {
      console.log(
        `\n── ${c.id} ──\nexpected: ${c.reference.slice(0, 160)}\ngot:      ${text.slice(0, 160)}`,
      );
    } else {
      console.log(`\n── ${c.id} ──\n${text.slice(0, 600)}`);
    }
  }

  console.log('\n');
  console.log(
    ['case', 'char', 'word', 'NUMERIC', 'math', 'seg', 'conf', 'calls', 'crops', 'cents', 'ms']
      .map((h) => h.padEnd(9))
      .join(''),
  );
  for (const r of rows) {
    console.log(
      [
        r.id.slice(0, 8),
        r.score.characterAccuracy.toFixed(2),
        r.score.wordAccuracy.toFixed(2),
        r.score.numericAccuracy.toFixed(2),
        r.score.mathAccuracy.toFixed(2),
        r.segmentation.toFixed(2),
        r.confidence.toFixed(2),
        String(r.calls),
        String(r.cropCalls),
        (r.millicents / 1000).toFixed(3),
        String(r.ms),
      ]
        .map((c) => String(c).padEnd(9))
        .join(''),
    );
  }

  const mean = (pick: (r: Row) => number) => rows.reduce((s, r) => s + pick(r), 0) / rows.length;
  const numericErrors = rows.flatMap((r) => r.score.numericErrors);

  console.log('\nmeans');
  console.log(`  character accuracy  ${mean((r) => r.score.characterAccuracy).toFixed(3)}`);
  console.log(`  word accuracy       ${mean((r) => r.score.wordAccuracy).toFixed(3)}`);
  // Called out on its own because a pipeline that reads the words and changes
  // the numbers is not usable for an exam, however good the other rows look.
  console.log(`  NUMERIC accuracy    ${mean((r) => r.score.numericAccuracy).toFixed(3)}`);
  console.log(`  maths preserved     ${mean((r) => r.score.mathAccuracy).toFixed(3)}`);
  console.log(`  segmentation        ${mean((r) => r.segmentation).toFixed(3)}`);
  console.log(
    `  confidence calib.   ${confidenceCalibration(
      rows.map((r) => ({ confidence: r.confidence, accuracy: r.score.characterAccuracy })),
    ).toFixed(3)}`,
  );
  console.log(`  cost per page       ${(mean((r) => r.millicents) / 1000).toFixed(3)}¢`);
  console.log(`  latency per page    ${Math.round(mean((r) => r.ms))}ms`);

  if (numericErrors.length) {
    console.log('\nnumbers that changed:');
    for (const e of numericErrors) console.log(`  ${e.expected} → ${e.got ?? '(missing)'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
