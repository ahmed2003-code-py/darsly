/**
 * Question generation, LUNA_FIRST against SOL_FIRST, on text already read.
 *
 *   # free: the plan, the calls it would make, and each call's worst case
 *   npx ts-node --transpile-only scripts/gen-bench/compare.ts \
 *     --source source.json --mcq 14 --tf 3 --written 3
 *
 *   # paid — only with explicit approval
 *   npx ts-node --transpile-only scripts/gen-bench/compare.ts \
 *     --source source.json --mcq 14 --tf 3 --written 3 --budget 10 --max-total 20 \
 *     --sol-effort low --confirm-paid --out <dir>
 *
 * The source is export-source.ts's file: no page is uploaded or read again.
 * Both profiles get the same chunks, the same spec, the same prompts, schema,
 * validation and limits — GenerationRun and QuestionGeneratorService as
 * production runs them; only the profile differs. Each run is capped at
 * --budget cents (default 10), and the runs together at --max-total (default
 * 20): a run is not started if the budgets could pass it. A run that stops on
 * its budget is reported as stopped, never given more.
 *
 * --sol-effort sets SOL_FIRST's writer effort for this process only (it is
 * PAPER_IMPORT_GENERATION_EFFORT, read by PaperImportConfig); LUNA_FIRST's
 * Sol fallback keeps its own effort. Production is untouched.
 *
 * AiCallLog rows go to DATABASE_URL, which must be local for a paid run.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AcademySiteConfig } from '../../src/academy-site/academy-site.config';
import { AiClient } from '../../src/academy-site/ai/ai.client';
import { withAiTrace } from '../../src/academy-site/ai/ai-trace';
import { normalizeSpec } from '../../src/paper-import/exam-spec';
import { GenerationReport, GenerationRun } from '../../src/paper-import/generation-run';
import {
  GenerationProfileName,
  PaperImportConfig,
} from '../../src/paper-import/paper-import.config';
import { QuestionGeneratorService } from '../../src/paper-import/question-generator.service';
import { GradedQuestion } from '../../src/paper-import/question-quality';
import { SourceChunk } from '../../src/paper-import/source-text';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const cents = (m: number) => `${(m / 1000).toFixed(2)}¢`;

interface Source {
  record: {
    id: string;
    spec?: { types?: { MCQ: number; TRUE_FALSE: number; SHORT_ANSWER: number } };
  };
  ocrMillicents: number;
  chunks: SourceChunk[];
}

async function main() {
  const source = JSON.parse(readFileSync(arg('source')!, 'utf8')) as Source;
  const types = {
    MCQ: Number(arg('mcq', '14')),
    TRUE_FALSE: Number(arg('tf', '3')),
    SHORT_ANSWER: Number(arg('written', '3')),
  };
  const asked = normalizeSpec({
    questionCount: types.MCQ + types.TRUE_FALSE + types.SHORT_ANSWER,
    types,
    difficulty: 'MIXED',
    language: 'AUTO',
  });
  const budgetCents = Number(arg('budget', '10'));
  const maxTotalCents = Number(arg('max-total', '20'));
  const profiles = arg('profiles', 'LUNA_FIRST,SOL_FIRST')!.split(',') as GenerationProfileName[];
  const paid = flag('confirm-paid');
  const out = arg('out', `gen-bench-${Date.now()}`)!;
  const solEffort = arg('sol-effort');
  if (solEffort) process.env.PAPER_IMPORT_GENERATION_EFFORT = solEffort;
  const config = new PaperImportConfig();

  if (budgetCents * profiles.length > maxTotalCents)
    throw new Error(
      `${profiles.length} × ${budgetCents}¢ could pass --max-total ${maxTotalCents}¢; nothing was called`,
    );
  // Only the two writers; the flagship is never a writer, not even by env var.
  const WRITERS = ['gpt-6-luna', 'gpt-6-sol'];
  for (const name of profiles) {
    const p = config.generationProfileOf(name);
    for (const tier of [p.primary, p.fallback])
      if (tier && !WRITERS.includes(tier.model))
        throw new Error(`${name} would call ${tier.model}; only ${WRITERS.join(', ')} may write`);
    console.log(
      `${name}: writes on ${p.primary.model}/${p.primary.effort}` +
        (p.fallback ? `, fallback ${p.fallback.model}/${p.fallback.effort}` : ', no fallback'),
    );
  }
  if (paid) {
    const host = /@([^:/?]+)/.exec(process.env.DATABASE_URL ?? '')?.[1] ?? '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host))
      throw new Error(`DATABASE_URL points at ${host || 'nothing'}; a paid run logs only locally`);
  }

  const original = source.record.spec?.types;
  console.log(
    `source ${source.record.id}: ${source.chunks.length} chunk(s), ` +
      `${source.chunks.reduce((n, c) => n + c.tokensApprox, 0)} tokens approx; ` +
      `BENCHMARK distribution ${types.MCQ}/${types.TRUE_FALSE}/${types.SHORT_ANSWER} ` +
      `(the teacher asked ${original ? `${original.MCQ}/${original.TRUE_FALSE}/${original.SHORT_ANSWER}` : 'unknown'}); ` +
      `budget ${budgetCents}¢ per profile, ${maxTotalCents}¢ in all; ` +
      `${paid ? 'PAID' : 'dry run, nothing is called'}`,
  );

  if (!paid) {
    // Every question passes on the first try: the fewest calls a run can
    // make, and what the budget would reserve for each.
    for (const name of profiles) {
      const gen = new QuestionGeneratorService({} as never, config);
      const plan: string[] = [];
      gen.generate = async (req) => {
        plan.push(
          `  ${req.mode.padEnd(8)} ${req.tier.model}/${req.tier.effort} ` +
            `${req.plan.length}q  worst case ${cents(gen.worstCase(req))}`,
        );
        return {
          questions: req.plan.map((p, i) => ({
            type: p.type,
            difficulty: p.difficulty,
            // One real word of the chunk, so it is anchored; the rest unique,
            // so it is not a duplicate. Only the call plan matters here.
            text: `ما ${anchorWord(req.chunks[0].text)} ${rnd()} ${rnd()} ${rnd()} ${i}؟`,
            options:
              p.type === 'SHORT_ANSWER'
                ? []
                : (p.type === 'MCQ' ? ['أ', 'ب', 'ج', 'د'] : ['صح', 'خطأ']).map((l, k) => ({
                    label: l,
                    text: `${l} ${k}`,
                    correct: k === 0,
                  })),
            modelAnswer: p.type === 'SHORT_ANSWER' ? req.chunks[0].text.slice(0, 40) : '',
            explanation: '',
            marks: p.marks,
            chunkIndex: req.chunks[0].index,
          })),
          insufficient: false,
          supportable: req.plan.length,
          model: req.tier.model,
          inputTokens: 0,
          outputTokens: 0,
          millicents: 0,
          error: null,
        };
      };
      await new GenerationRun(gen, config).run({
        importId: source.record.id,
        asked,
        chunks: source.chunks,
        profile: config.generationProfileOf(name),
        budgetMillicents: budgetCents * 1000,
      });
      console.log(`${name}:\n${plan.join('\n')}`);
    }
    console.log('\nNothing was sent. Re-run with --confirm-paid once the comparison is approved.');
    return;
  }

  const prisma = new PrismaClient();
  const ai = new AiClient(new AcademySiteConfig(), prisma as never);
  const generator = new QuestionGeneratorService(ai, config);
  mkdirSync(out, { recursive: true });
  const reports: GenerationReport[] = [];

  let spent = 0;
  for (const name of profiles) {
    if (spent + budgetCents * 1000 > maxTotalCents * 1000) {
      console.log(`${name}: not started, ${cents(spent)} already charged of ${maxTotalCents}¢`);
      continue;
    }
    const run = `bench:${source.record.id}:${name}:${Date.now()}`;
    const { questions, report } = await withAiTrace({ importId: run, phase: 'GENERATE' }, () =>
      new GenerationRun(generator, config).run({
        importId: run,
        asked,
        chunks: source.chunks,
        profile: config.generationProfileOf(name),
        budgetMillicents: budgetCents * 1000,
      }),
    );
    reports.push(report);
    spent += report.chargedMillicents;
    writeFileSync(join(out, `${name}.report.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(out, `${name}.questions.json`), JSON.stringify(questions, null, 2));
    writeFileSync(join(out, `${name}.review.md`), reviewSheet(name, questions, source.chunks));
    console.log(`${name}: ${report.accepted}/${report.requested}, ${cents(report.millicents)}`);
  }

  writeFileSync(
    join(out, 'summary.md'),
    `Benchmark distribution ${types.MCQ} MCQ / ${types.TRUE_FALSE} true-false / ` +
      `${types.SHORT_ANSWER} short answer — not the teacher's original request.\n\n` +
      summary(reports, source.ocrMillicents),
  );
  console.log(readFileSync(join(out, 'summary.md'), 'utf8'));
  await prisma.$disconnect();
}

const rnd = () =>
  Math.random()
    .toString(36)
    .replace(/[^a-z]/g, '')
    .slice(0, 7) || 'abcdefg';
const anchorWord = (text: string) =>
  text.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 4) ?? 'material';

function summary(reports: GenerationReport[], ocr: number): string {
  const row = (label: string, f: (r: GenerationReport) => string) =>
    `| ${label} | ${reports.map(f).join(' | ')} |`;
  const missing = (r: GenerationReport) =>
    Object.entries(r.missingByType)
      .filter(([, n]) => n)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ') || 'none';
  const count = (r: GenerationReport, m: string) => String(r.callsByModel[m] ?? 0);
  // The first round's calls on the profile's own writer, and everything after
  // them: replacements, variants and fallback calls.
  const initial = (r: GenerationReport) =>
    r.callLog.filter((c) => c.stage === 'INITIAL' && c.round === 0);
  const later = (r: GenerationReport) => r.callLog.filter((c) => !initial(r).includes(c));
  const sum = (calls: GenerationReport['callLog']) => calls.reduce((n, c) => n + c.millicents, 0);
  const others = (r: GenerationReport) =>
    Object.entries(r.rejections)
      .filter(([k, n]) => k !== 'DUPLICATE' && n)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') || 'none';
  return [
    `| Metric | ${reports.map((r) => r.profile).join(' | ')} |`,
    `|---|${reports.map(() => '---').join('|')}|`,
    row('Requested questions', (r) => String(r.requested)),
    row('Accepted questions', (r) => `${r.accepted} (${r.variants} variants)`),
    row('Missing questions by type', missing),
    row('Stopped because', (r) => r.stopReason ?? '—'),
    row('Initial generation cost [recorded]', (r) => cents(sum(initial(r)))),
    row('Retry / variant / fallback cost [recorded]', (r) => cents(sum(later(r)))),
    row('Total generation cost [recorded]', (r) => cents(r.millicents)),
    row(
      'Charged against budget',
      (r) => `${cents(r.chargedMillicents)} of ${cents(r.budgetMillicents)}`,
    ),
    row('OCR cost [recorded, original import]', () => cents(ocr)),
    row('Total exam cost [recorded]', (r) => cents(r.millicents + ocr)),
    row('Generation latency', (r) => `${(r.durationMs / 1000).toFixed(1)} s`),
    row(
      'Total end-to-end latency',
      (r) => `${(r.durationMs / 1000).toFixed(1)} s + OCR (not re-run)`,
    ),
    row('Cost per accepted question', (r) => (r.accepted ? cents(r.millicents / r.accepted) : '—')),
    row('Total AI calls', (r) => String(r.calls)),
    row('Luna calls', (r) => count(r, 'gpt-6-luna')),
    row('Sol calls', (r) => count(r, 'gpt-6-sol')),
    row('Astra calls — expected zero', (r) => count(r, 'gpt-6-astra')),
    row('Actual model calls by model', (r) => JSON.stringify(r.callsByModel)),
    row('Duplicate rejections', (r) => String(r.rejections.DUPLICATE ?? 0)),
    row('Other rejection reasons', others),
    '',
    'Recorded = provider-reported tokens × configured prices (PAPER_IMPORT_*_PRICE_*), cached input not discounted. Not the provider invoice.',
  ].join('\n');
}

/** One page per profile for a person to mark: is it right, is it fair, is
 *  the Arabic natural, is the answer defensible. */
function reviewSheet(name: string, questions: GradedQuestion[], chunks: SourceChunk[]): string {
  return [
    `# ${name} — manual review`,
    '',
    'Mark each: correct (Y/N) · difficulty as labelled (Y/N) · Arabic natural (1–5) · answer/distractors defensible (1–5) · notes',
    '',
    ...questions.map((q, i) => {
      const chunk = chunks.find((c) => c.index === q.chunkIndex);
      return [
        `## ${i + 1}. ${q.type}${q.variant ? ' (variant)' : ''} — chunk ${q.chunkIndex}, page ${chunk?.page ?? '?'}`,
        '',
        q.text,
        '',
        ...(q.options ?? []).map((o) => `- ${o.correct ? '**✓**' : '  '} ${o.label} ${o.text}`),
        q.modelAnswer ? `\nModel answer: ${q.modelAnswer}` : '',
        '',
        'correct: _ · difficulty: _ · Arabic: _ · answer: _ · notes:',
        '',
      ].join('\n');
    }),
  ].join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
