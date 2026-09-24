/**
 * What one real import cost and where its time went — read from the
 * database, never re-run.
 *
 *   npx ts-node --transpile-only scripts/ocr-bench/prod-run-report.ts [importId]
 *
 * Reads PROD_DATABASE_URL (kept in apps/api/.env, which git ignores) and opens
 * it READ ONLY: the session is started with default_transaction_read_only, so
 * Postgres itself refuses any write this script might attempt. No model is
 * called. Without an id it reports the most recent paper import.
 *
 * Everything priced here is the APPLICATION'S ESTIMATE — recorded tokens
 * times the prices the app is configured with. The provider's bill is not in
 * this database; the response ids printed are what to look up in the
 * provider's usage export to reconcile.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('PROD_DATABASE_URL is not set (add it to apps/api/.env — never commit it).');
  process.exit(1);
}
const readOnly =
  url + (url.includes('?') ? '&' : '?') + 'options=-c%20default_transaction_read_only%3Don';
const prisma = new PrismaClient({ datasources: { db: { url: readOnly } } });

const ms = (d: Date | null | undefined) => (d ? new Date(d).getTime() : NaN);
const s = (n: number) => `${(n / 1000).toFixed(1)}s`;
const c = (millicents: number) => `${(millicents / 1000).toFixed(2)}¢`;

async function main() {
  const tz = await prisma.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW timezone');
  const ro = await prisma.$queryRawUnsafe<{ default_transaction_read_only: string }[]>(
    'SHOW default_transaction_read_only',
  );
  console.log(
    `database timezone=${tz[0]?.TimeZone} read_only=${ro[0]?.default_transaction_read_only}`,
  );

  const wanted = process.argv[2];
  // Only the columns this report needs — no exam content (draft, warnings),
  // no teacher or academy identifiers — so it runs under a role granted
  // exactly these columns and nothing else (see prod-run-report.sql).
  const importColumns = {
    id: true,
    kind: true,
    status: true,
    stage: true,
    createdAt: true,
    updatedAt: true,
    durationMs: true,
    costCents: true,
    inputTokens: true,
    outputTokens: true,
    escalatedPages: true,
    highAccuracy: true,
  } as const;
  const imp = wanted
    ? await prisma.paperImport.findUnique({ where: { id: wanted }, select: importColumns })
    : await prisma.paperImport.findFirst({
        where: { kind: 'PAPER' },
        orderBy: { createdAt: 'desc' },
        select: importColumns,
      });
  if (!imp) throw new Error('No import found');

  console.log('\n## Import');
  console.log(
    JSON.stringify(
      {
        id: imp.id,
        kind: imp.kind,
        status: imp.status,
        stage: imp.stage,
        createdAt: imp.createdAt,
        updatedAt: imp.updatedAt,
        wallClock: s(ms(imp.updatedAt) - ms(imp.createdAt)),
        durationMs: imp.durationMs,
        recordedCostCents: imp.costCents,
        inputTokens: imp.inputTokens,
        outputTokens: imp.outputTokens,
        escalatedPages: imp.escalatedPages,
        highAccuracy: imp.highAccuracy,
      },
      null,
      2,
    ),
  );

  const jobs = await prisma.aiJob.findMany({
    where: { input: { path: ['importId'], equals: imp.id } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      status: true,
      attempts: true,
      stage: true,
      createdAt: true,
      updatedAt: true,
      costCents: true,
      errorClass: true,
    },
  });
  console.log('\n## Jobs');
  for (const j of jobs) {
    console.log(
      `${j.id} status=${j.status} attempts=${j.attempts} stage=${j.stage} created=${j.createdAt.toISOString()} ` +
        `updated=${j.updatedAt.toISOString()} ran≈${s(ms(j.updatedAt) - ms(j.createdAt))} costCents=${j.costCents}`,
    );
  }
  if (jobs.some((j) => j.attempts > 1)) {
    console.log('!! a job ran more than once — see the lease fix in dc24155');
  }

  let calls: any[] = [];
  try {
    calls = await prisma.aiCallLog.findMany({
      where: { importId: imp.id },
      orderBy: { startedAt: 'asc' },
      select: {
        stage: true,
        region: true,
        attempt: true,
        model: true,
        reasoningEffort: true,
        imageCount: true,
        startedAt: true,
        latencyMs: true,
        status: true,
        error: true,
        responseId: true,
        inputTokens: true,
        cachedInputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        costMillicents: true,
        meta: true,
      },
    });
  } catch (e) {
    console.log(
      `\nAiCallLog could not be read (${(e as Error).message.slice(0, 120)}) — per-call data unavailable.`,
    );
  }
  if (!calls.length) {
    console.log(
      '\nNo AiCallLog rows for this import: per-call cost and timing are unavailable; only the totals above are.',
    );
    return;
  }

  // ── strategy, from what actually ran ─────────────────────────────────────
  const stages = new Set(calls.map((x) => x.stage));
  const adaptive = calls.some((x) => x.meta?.rung);
  const batched = stages.has('OCR_REGION_BATCH');
  const total = calls.reduce((a, x) => a + x.costMillicents, 0);
  console.log('\n## What ran');
  console.log(
    `strategy=${adaptive ? 'adaptive' : 'current'} batching=${batched ? 'yes' : 'no'} calls=${calls.length} ` +
      `estimatedCost=${c(total)} ($${(total / 100000).toFixed(4)})`,
  );
  if (adaptive) {
    const reading = calls.filter(
      (x) => x.stage !== 'OCR_STRUCTURE' && x.stage !== 'OCR_STRUCTURE_RETRY',
    );
    const spent = reading.reduce((a, x) => a + x.costMillicents, 0);
    console.log(
      `reading cost ${c(spent)} vs default page budget 10¢ → ${spent >= 10000 ? 'REACHED' : 'not reached'} ` +
        `(the budget only limits medium/high recovery; the log line BUDGET_STOP is in the app log, not the database)`,
    );
  }

  // ── cost, grouped ─────────────────────────────────────────────────────────
  const group = (key: (x: any) => string) => {
    const g = new Map<string, any>();
    for (const x of calls) {
      const k = key(x);
      const r = g.get(k) ?? { calls: 0, in: 0, cached: 0, out: 0, reasoning: 0, cost: 0, busy: 0 };
      r.calls++;
      r.in += x.inputTokens;
      r.cached += x.cachedInputTokens;
      r.out += x.outputTokens;
      r.reasoning += x.reasoningTokens;
      r.cost += x.costMillicents;
      r.busy += x.latencyMs;
      g.set(k, r);
    }
    return [...g.entries()].sort((a, b) => b[1].cost - a[1].cost);
  };
  const table = (title: string, key: (x: any) => string) => {
    console.log(`\n## By ${title}`);
    for (const [k, r] of group(key)) {
      console.log(
        `${k.padEnd(34)} calls=${String(r.calls).padStart(2)} in=${r.in} cached=${r.cached} out=${r.out} ` +
          `reasoning=${r.reasoning} cost=${c(r.cost)} (${((r.cost / total) * 100).toFixed(0)}%) callTime=${s(r.busy)}`,
      );
    }
  };
  table('model', (x) => x.model);
  table('reasoning effort', (x) => `${x.model}/${x.reasoningEffort ?? '-'}`);
  table(
    'stage',
    (x) => `${x.stage}${x.meta?.rung ? ` ${x.meta.rung}/${x.meta.variant ?? ''}` : ''}`,
  );

  // ── timeline ──────────────────────────────────────────────────────────────
  const t0 = Math.min(ms(imp.createdAt), ...jobs.map((j) => ms(j.createdAt)));
  const firstCall = ms(calls[0].startedAt);
  const lastEnd = Math.max(...calls.map((x) => ms(x.startedAt) + x.latencyMs));
  console.log('\n## Timeline (seconds from upload)');
  console.log(`upload/import created           0.0s`);
  for (const j of jobs)
    console.log(`job queued ${j.id.slice(-6)}                 ${s(ms(j.createdAt) - t0)}`);
  console.log(
    `first model call started       ${s(firstCall - t0)}   ← queue + page preparation before any call`,
  );
  for (const x of calls) {
    const st = ms(x.startedAt) - t0;
    console.log(
      `  ${s(st).padStart(7)} → ${s(st + x.latencyMs).padStart(7)}  ${String(x.stage).padEnd(18)} ` +
        `${(x.meta?.rung ?? '').padEnd(10)} ${(x.meta?.variant ?? '').padEnd(8)} ${x.model}/${x.reasoningEffort ?? '-'} ` +
        `imgs=${x.imageCount} out=${x.outputTokens} (reasoning ${x.reasoningTokens}) ${c(x.costMillicents)} ${x.status}` +
        (x.meta?.crops ? ` crops=${x.meta.crops}` : ''),
    );
  }
  console.log(`last model call ended          ${s(lastEnd - t0)}`);
  console.log(
    `import last updated            ${s(ms(imp.updatedAt) - t0)}   ← structuring, validation, persistence after the last call`,
  );

  // Per stage: wall time from first start to last end, against the time its
  // calls add up to — the difference is how much ran side by side.
  console.log('\n## Per stage: wall time vs summed call time');
  const byStage = new Map<string, any[]>();
  for (const x of calls) {
    const k = `${x.stage}${x.meta?.rung ? ` ${x.meta.rung}/${x.meta.variant ?? ''}` : ''}`;
    byStage.set(k, [...(byStage.get(k) ?? []), x]);
  }
  for (const [k, xs] of byStage) {
    const start = Math.min(...xs.map((x) => ms(x.startedAt)));
    const end = Math.max(...xs.map((x) => ms(x.startedAt) + x.latencyMs));
    const sum = xs.reduce((a, x) => a + x.latencyMs, 0);
    console.log(
      `${k.padEnd(34)} wall=${s(end - start).padStart(7)} summed=${s(sum).padStart(7)} ` +
        `parallelism≈${(sum / Math.max(1, end - start)).toFixed(1)}x calls=${xs.length}`,
    );
  }

  // Idle: moments with no model call in flight between the first and last.
  const events = calls
    .flatMap((x) => [
      { t: ms(x.startedAt), d: 1 },
      { t: ms(x.startedAt) + x.latencyMs, d: -1 },
    ])
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let inFlight = 0;
  let idleFrom = firstCall;
  let idle = 0;
  let peak = 0;
  for (const e of events) {
    if (inFlight === 0 && e.d === 1) idle += Math.max(0, e.t - idleFrom);
    inFlight += e.d;
    peak = Math.max(peak, inFlight);
    if (inFlight === 0) idleFrom = e.t;
  }
  console.log(
    `\nno call in flight for ${s(idle)} between the first and last call; peak concurrency ${peak}`,
  );

  console.log('\n## Response ids (to reconcile with the provider usage export)');
  console.log(calls.map((x) => x.responseId ?? '(none)').join('\n'));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
