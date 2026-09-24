#!/usr/bin/env node
/**
 * One exam, costed call by call.
 *
 *   node scripts/audit-exam-cost.mjs run <file.pdf> [--mcq 10 --tf 5 --written 5]
 *   node scripts/audit-exam-cost.mjs report <importId>
 *
 * `run` drives the same HTTP flow a teacher's browser does — log in, upload
 * the material as a CONTENT session, wait for it to be read, ask for the
 * exam, wait for it to be written — against a running API (API_BASE,
 * default http://localhost:41000/api/v1), then prints the report.
 *
 * `report` reads only AiCallLog rows (one per model call, written by
 * AiClient) and the PaperImport they belong to. Nothing here is derived from
 * the application's own totals; those are reconciled against the sum of the
 * calls at the end, not trusted.
 *
 * Labels: [MEASURED] comes straight from the provider's usage report on each
 * call. [PRICED] is a measured token count multiplied by the prices the app is
 * configured with (PAPER_IMPORT_*_PRICE_*), which are not verified against the
 * provider's invoice. [UNKNOWN] is anything neither can say.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'apps/api/package.json'));
const { PrismaClient } = require('@prisma/client');

const API = process.env.API_BASE ?? 'http://localhost:41000/api/v1';
const LOGIN = process.env.AUDIT_LOGIN ?? 'teacher1@darsly.app';
const PASSWORD = process.env.AUDIT_PASSWORD ?? 'Darsly@123';
const OUT = process.env.AUDIT_OUT ?? '.';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

async function http(method, path, token, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(token, id, done) {
  const started = Date.now();
  for (;;) {
    const r = await http('GET', `/teacher/paper-imports/${id}`, token);
    process.stdout.write(
      `\r  ${r.status}/${r.stage} ${r.progressDone ?? 0}/${r.progressTotal ?? 0} — ${Math.round((Date.now() - started) / 1000)}s   `,
    );
    if (done(r)) {
      process.stdout.write('\n');
      return r;
    }
    if (Date.now() - started > 45 * 60_000) throw new Error('gave up after 45 minutes');
    await sleep(3000);
  }
}

async function run(file) {
  const types = { MCQ: arg('mcq', 10), TRUE_FALSE: arg('tf', 5), SHORT_ANSWER: arg('written', 5) };
  const questionCount = types.MCQ + types.TRUE_FALSE + types.SHORT_ANSWER;
  console.log(`Logging in as ${LOGIN} …`);
  const auth = await http('POST', '/auth/login', null, { identifier: LOGIN, password: PASSWORD });
  const token = auth.accessToken;

  console.log(`Uploading ${basename(file)} as lecture material …`);
  const form = new FormData();
  form.append('kind', 'CONTENT');
  form.append('files', new Blob([readFileSync(file)], { type: 'application/pdf' }), basename(file));
  const created = await http('POST', '/teacher/paper-imports', token, form);
  const id = created.id;
  console.log(`  session ${id}`);

  console.log('Reading the material …');
  await waitFor(token, id, (r) => ['CONFIGURING', 'REVIEW', 'FAILED'].includes(r.status));

  console.log(`Asking for ${questionCount} questions ${JSON.stringify(types)} …`);
  await http('PUT', `/teacher/paper-imports/${id}/spec`, token, {
    questionCount,
    difficulty: 'MIXED',
    mix: { EASY: 30, MEDIUM: 50, HARD: 20 },
    types,
    language: 'AUTO',
  });
  await sleep(2000);
  await waitFor(
    token,
    id,
    (r) => ['REVIEW', 'FAILED'].includes(r.status) && r.stage !== 'GENERATING',
  );

  // The AiCallLog write is fire-and-forget; give the last one a moment.
  await sleep(2000);
  await report(id, types);
}

// ── the report ────────────────────────────────────────────────────────────

const usd = (millicents) => `$${(millicents / 100_000).toFixed(4)}`;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A call's output cost split into the part that was reasoning. */
const reasoningCost = (c) =>
  Math.round((c.reasoningTokens / 1_000_000) * (c.priceOutPerMToken ?? 0) * 1000);

const STAGE_GROUP = {
  SOURCE_READ: 'OCR_PAGE',
  EXTRACT_PAGE: 'OCR_PAGE',
  OCR_PAGE: 'OCR_PAGE',
  OCR_REGION: 'OCR_REGION',
  OCR_FRAGMENT: 'OCR_REGION',
  OCR_RETRY: 'OCR_RETRY',
  SOURCE_READ_ESCALATION: 'OCR_ESCALATION',
  EXTRACT_ESCALATION: 'OCR_ESCALATION',
  OCR_STRUCTURE: 'OCR_RECONCILIATION',
  QUESTION_GENERATION: 'QUESTION_GENERATION',
  QUESTION_REGENERATION: 'QUESTION_REGENERATION',
  QUESTION_VARIANTS: 'QUESTION_VARIANTS',
};

async function report(id, types) {
  const prisma = new PrismaClient();
  const imp = await prisma.paperImport.findUnique({
    where: { id },
    include: { pages: { orderBy: { pageNumber: 'asc' } } },
  });
  const calls = await prisma.aiCallLog.findMany({
    where: { importId: id },
    orderBy: { startedAt: 'asc' },
  });
  await prisma.$disconnect();
  if (!imp) throw new Error(`No import ${id}`);

  const total = sum(calls, 'costMillicents');
  const out = [];
  const p = (s = '') => out.push(s);

  // What came out.
  const qs = (imp.draft?.sections ?? []).flatMap((s) => s.questions ?? []);
  const byType = qs.reduce((m, q) => ((m[q.type] = (m[q.type] ?? 0) + 1), m), {});
  const objective = (byType.MCQ ?? 0) + (byType.TRUE_FALSE ?? 0);
  const written = byType.SHORT_ANSWER ?? 0;
  const pages = imp.pages.length;
  const textPages = imp.pages.filter((pg) => pg.textKey && !pg.model).length;

  p('# EXAM AI COST AUDIT');
  p();
  p(`Session \`${id}\` · ${imp.kind} · ${new Date(imp.createdAt).toISOString()}`);
  p();
  p('Prices are the ones the app is configured with, per call, not the provider invoice.');
  p('Every token count is [MEASURED] from the provider usage report on that call.');
  p();

  p('## 1. Executive summary');
  p();
  p(
    table(
      ['', 'Value'],
      [
        ['Total cost [PRICED]', usd(total)],
        ['Model calls [MEASURED]', calls.length],
        ['Cost / page', usd(pages ? total / pages : 0)],
        ['Cost / question produced', usd(qs.length ? total / qs.length : 0)],
      ],
    ),
  );
  p();

  p('## 2. Actual output');
  p();
  const want = types
    ? `${types.MCQ + types.TRUE_FALSE + types.SHORT_ANSWER} = ${types.MCQ} MCQ + ${types.TRUE_FALSE} T/F + ${types.SHORT_ANSWER} written`
    : JSON.stringify(imp.spec?.types ?? {});
  p(
    table(
      ['', 'Value'],
      [
        ['Asked for', want],
        [
          'Produced',
          `${qs.length} = ${byType.MCQ ?? 0} MCQ + ${byType.TRUE_FALSE ?? 0} T/F + ${written} written`,
        ],
        ['Objective / written', `${objective} / ${written}`],
        ['Final status', `${imp.status} / ${imp.stage}`],
        ['PDF pages', `${pages} (${textPages} read from the text layer, no model call)`],
        ['Warnings', (imp.warnings ?? []).map((w) => w.code).join(', ') || 'none'],
        ['Needs-review questions', qs.filter((q) => q.needsReview).length],
      ],
    ),
  );
  p();

  // By model.
  p('## 3. Cost by model');
  p();
  const models = [...new Set(calls.map((c) => c.model))];
  p(
    table(
      [
        'Model',
        'Calls',
        'Input',
        'Cached in',
        'Output',
        'Reasoning',
        'Cost',
        'Avg/call',
        'Max/call',
        '%',
      ],
      models.map((m) => {
        const rs = calls.filter((c) => c.model === m);
        const cost = sum(rs, 'costMillicents');
        return [
          m,
          rs.length,
          sum(rs, 'inputTokens'),
          sum(rs, 'cachedInputTokens'),
          sum(rs, 'outputTokens'),
          sum(rs, 'reasoningTokens'),
          usd(cost),
          usd(cost / rs.length),
          usd(Math.max(...rs.map((r) => r.costMillicents))),
          pct(cost, total),
        ];
      }),
    ),
  );
  p();

  // By stage.
  p('## 4. Cost by stage');
  p();
  const stages = [...new Set(calls.map((c) => c.stage ?? 'OTHER'))];
  p(
    table(
      ['Stage (as recorded)', 'Report group', 'Calls', 'Failed', 'Cost', '%'],
      stages.map((s) => {
        const rs = calls.filter((c) => (c.stage ?? 'OTHER') === s);
        const cost = sum(rs, 'costMillicents');
        return [
          s,
          STAGE_GROUP[s] ?? 'OTHER',
          rs.length,
          rs.filter((r) => r.status !== 'ok').length,
          usd(cost),
          pct(cost, total),
        ];
      }),
    ),
  );
  p();
  p(
    'Not separate stages in this pipeline: question validation, repair and essay validation are ' +
      'deterministic code (question-quality.ts), not model calls, so they cost nothing. ' +
      'Essays are written in the same generation calls as objective questions.',
  );
  p();

  // By page.
  p('## 5. Cost by page');
  p();
  const pageNums = imp.pages.map((pg) => pg.pageNumber);
  const perPage = pageNums.map((n) => {
    const rs = calls.filter((c) => c.pageNumber === n);
    return {
      n,
      calls: rs.length,
      ocr: rs.filter((c) => (STAGE_GROUP[c.stage] ?? '').startsWith('OCR')).length,
      retries: rs.filter((c) => (c.attempt ?? 0) > 0).length,
      escalations: rs.filter((c) => /ESCALATION|RETRY/.test(c.stage ?? '')).length,
      input: sum(rs, 'inputTokens'),
      output: sum(rs, 'outputTokens'),
      reasoning: sum(rs, 'reasoningTokens'),
      cost: sum(rs, 'costMillicents'),
      source: imp.pages.find((pg) => pg.pageNumber === n)?.model ?? 'text layer',
    };
  });
  p(
    table(
      ['Page', 'Read by', 'Calls', 'OCR', 'Retries', 'Escal.', 'In', 'Out', 'Reason.', 'Cost'],
      perPage.map((r) => [
        r.n,
        r.source,
        r.calls,
        r.ocr,
        r.retries,
        r.escalations,
        r.input,
        r.output,
        r.reasoning,
        usd(r.cost),
      ]),
    ),
  );
  const pageCosts = perPage.map((r) => r.cost);
  const readingCost = sum(perPage, 'cost');
  p();
  p(
    `Average ${usd(pages ? readingCost / pages : 0)} · median ${usd(median(pageCosts))} · max ${usd(Math.max(0, ...pageCosts))}` +
      ` · reading as a whole ${usd(readingCost)} = ${pct(readingCost, total)} of the exam.`,
  );
  p();

  // Generation, objective vs written.
  p('## 6. Question generation');
  p();
  const gen = calls.filter((c) => /^QUESTION_/.test(c.stage ?? ''));
  const genCost = sum(gen, 'costMillicents');
  const plannedOf = (c) => c.meta?.planned ?? {};
  // A call writes both kinds at once; its cost is split by how many of each it
  // was asked for. That split is [ESTIMATED] — the provider reports one bill
  // per call, not per question.
  let objCost = 0;
  let wrCost = 0;
  for (const c of gen) {
    const pl = plannedOf(c);
    const o = (pl.MCQ ?? 0) + (pl.TRUE_FALSE ?? 0);
    const w = pl.SHORT_ANSWER ?? 0;
    const n = o + w || 1;
    objCost += (c.costMillicents * o) / n;
    wrCost += (c.costMillicents * w) / n;
  }
  p(
    table(
      ['', 'Value'],
      [
        ['Generation calls [MEASURED]', gen.length],
        ['Generation cost [PRICED]', usd(genCost)],
        [
          '… first attempts',
          usd(
            sum(
              gen.filter((c) => c.stage === 'QUESTION_GENERATION'),
              'costMillicents',
            ),
          ),
        ],
        [
          '… flagship retries (QUESTION_REGENERATION)',
          usd(
            sum(
              gen.filter((c) => c.stage === 'QUESTION_REGENERATION'),
              'costMillicents',
            ),
          ),
        ],
        [
          '… variant rounds',
          usd(
            sum(
              gen.filter((c) => c.stage === 'QUESTION_VARIANTS'),
              'costMillicents',
            ),
          ),
        ],
        ['Objective share [ESTIMATED, split by planned count]', usd(objCost)],
        ['Written share [ESTIMATED, split by planned count]', usd(wrCost)],
        ['Per objective question', usd(objective ? objCost / objective : 0)],
        ['Per written question', usd(written ? wrCost / written : 0)],
        ['Validation / repair calls', '0 — deterministic code, no model'],
      ],
    ),
  );
  p();

  // Retries and escalations.
  p('## 7. Retries and escalations');
  p();
  const esc = calls.filter(
    (c) => (c.attempt ?? 0) > 0 || /ESCALATION|RETRY|REGENERATION/.test(c.stage ?? ''),
  );
  p(
    esc.length
      ? table(
          [
            'When',
            'Stage',
            'Page/batch',
            'Model',
            'Attempt',
            'Status',
            'Tokens in/out/reason',
            'Cost',
          ],
          esc.map((c) => [
            new Date(c.startedAt).toISOString().slice(11, 19),
            c.stage,
            c.pageNumber ?? (c.batch != null ? `batch ${c.batch}` : '—'),
            c.model,
            c.attempt ?? 0,
            c.status,
            `${c.inputTokens}/${c.outputTokens}/${c.reasoningTokens}`,
            usd(c.costMillicents),
          ]),
        )
      : 'None.',
  );
  const escCost = sum(esc, 'costMillicents');
  p();
  p(`Retries + escalations: ${usd(escCost)} = ${pct(escCost, total)} of the total.`);
  p();

  // Reasoning.
  p('## 8. Reasoning tokens');
  p();
  const outCost = calls.reduce(
    (s, c) => s + Math.round((c.outputTokens / 1_000_000) * (c.priceOutPerMToken ?? 0) * 1000),
    0,
  );
  const rCost = calls.reduce((s, c) => s + reasoningCost(c), 0);
  p(
    table(
      ['', 'Value'],
      [
        ['Output tokens (incl. reasoning) [MEASURED]', sum(calls, 'outputTokens')],
        ['… of which reasoning [MEASURED]', sum(calls, 'reasoningTokens')],
        ['Output cost [PRICED]', usd(outCost)],
        [
          '… of which reasoning [PRICED]',
          `${usd(rCost)} (${pct(rCost, outCost)} of output cost, ${pct(rCost, total)} of total)`,
        ],
        [
          'Calls that reported no reasoning figure',
          calls.filter((c) => c.status === 'ok' && c.reasoningEffort && !c.reasoningTokens).length,
        ],
      ],
    ),
  );
  p();

  // Cache.
  p('## 9. Cached input');
  p();
  const inTok = sum(calls, 'inputTokens');
  const cached = sum(calls, 'cachedInputTokens');
  p(
    table(
      ['', 'Value'],
      [
        ['Input tokens [MEASURED]', inTok],
        ['… of which cached [MEASURED]', `${cached} (${pct(cached, inTok)})`],
        [
          'Cache discount',
          "[UNKNOWN] — no cached-input price is configured, so cached tokens are costed at the full input price here; the invoice will be lower by the provider's cache discount on those tokens.",
        ],
      ],
    ),
  );
  p();

  // Top calls.
  p('## 10. Most expensive calls');
  p();
  p(
    table(
      [
        '#',
        'Stage',
        'Model',
        'Effort',
        'Page/batch',
        'In',
        'Cached',
        'Out',
        'Reason.',
        'Latency',
        'Cost',
      ],
      [...calls]
        .sort((a, b) => b.costMillicents - a.costMillicents)
        .slice(0, 10)
        .map((c, i) => [
          i + 1,
          c.stage ?? '—',
          c.model,
          c.reasoningEffort ?? '—',
          c.pageNumber ?? (c.batch != null ? `batch ${c.batch}` : '—'),
          c.inputTokens,
          c.cachedInputTokens,
          c.outputTokens,
          c.reasoningTokens,
          `${(c.latencyMs / 1000).toFixed(1)}s`,
          usd(c.costMillicents),
        ]),
    ),
  );
  p();

  // Reconciliation.
  p('## 11. Reconciliation');
  p();
  const recorded = imp.costCents * 1000;
  p(
    table(
      ['', 'Value'],
      [
        ['Sum of the individual calls', usd(total)],
        ["PaperImport.costCents (the app's own total)", usd(recorded)],
        ['Difference', usd(total - recorded)],
        ['Failed calls', calls.filter((c) => c.status !== 'ok').length],
        [
          'SDK-level retries',
          '[UNKNOWN] — the OpenAI SDK retries a timed-out request inside one call; only the final response is visible here. The provider usage export, joined on responseId, is the check.',
        ],
      ],
    ),
  );
  p();
  p(
    'Formula: each call = input_tokens × in-price/1M + output_tokens × out-price/1M (reasoning is inside output_tokens, cached inside input_tokens). Total = Σ calls.',
  );
  p();

  p('## 12. Projection (this exam × N, same material and spec) [ESTIMATED]');
  p();
  p(
    table(
      ['Exams', 'Cost'],
      [100, 1000, 10000].map((n) => [n, `$${((total / 100_000) * n).toFixed(2)}`]),
    ),
  );
  p();

  const md = out.join('\n');
  const mdPath = join(OUT, `exam-cost-audit-${id}.md`);
  const csvPath = join(OUT, `exam-cost-calls-${id}.csv`);
  writeFileSync(mdPath, md);
  const cols = [
    'startedAt',
    'latencyMs',
    'phase',
    'stage',
    'pageNumber',
    'region',
    'batch',
    'attempt',
    'model',
    'reasoningEffort',
    'imageDetail',
    'imageCount',
    'status',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningTokens',
    'priceInPerMToken',
    'priceOutPerMToken',
    'costMillicents',
    'responseId',
    'error',
  ];
  writeFileSync(
    csvPath,
    [
      cols.join(','),
      ...calls.map((c) => cols.map((k) => JSON.stringify(c[k] ?? '')).join(',')),
    ].join('\n'),
  );
  console.log(md);
  console.log(`\nWritten: ${mdPath}\n         ${csvPath}`);
}

const [, , cmd, target] = process.argv;
if (cmd === 'run' && target) await run(target);
else if (cmd === 'report' && target) await report(target);
else {
  console.error('usage: audit-exam-cost.mjs run <file.pdf> | report <importId>');
  process.exit(1);
}
