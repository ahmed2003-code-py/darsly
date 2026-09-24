/**
 * Re-score every stored benchmark run with one rule set, and print the table.
 *
 *   npx ts-node --transpile-only scripts/ocr-bench/rescore.ts <bench-dir>
 *
 * No model calls: it reads each run's detail.json (questions + AiCallLog
 * rows) and scores again, so a change to the scoring never needs a re-run.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PAPERS } from './ground-truth';
import { fold, similarity } from './run';
import { grounding } from '../../src/paper-import/ocr/validation';

/**
 * A question is recovered when its text is close to the reference, or when
 * nearly all of the reference is inside it. The second catches a question
 * that came out whole with a heading in front of it ("مثال ٢ حل …") — the
 * same question, which a teacher trims, not rewrites.
 */
const recovered = (reference: string, got: string) =>
  similarity(reference, got) >= 0.6 || grounding(fold(reference), fold(got)) >= 0.8;

function scoreRun(paperId: string, questions: any[]) {
  const paper = PAPERS.find((p) => p.id === paperId)!;
  const used = new Set<number>();
  let found = 0;
  let optionsOk = 0;
  let optionsTotal = 0;
  let textSum = 0;
  for (const exp of paper.expected) {
    let best = -1;
    let bestScore = -1;
    questions.forEach((q, i) => {
      if (used.has(i) || !recovered(exp.text, q.text ?? '')) return;
      const s = grounding(fold(exp.text), fold(q.text ?? ''));
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (exp.options) optionsTotal += exp.options.length;
    if (best < 0) continue;
    used.add(best);
    found++;
    textSum += similarity(exp.text, questions[best].text ?? '');
    if (exp.options) {
      const got = (questions[best].options ?? []).map((o: any) => fold(o.text ?? ''));
      for (const o of exp.options)
        if (got.some((g: string) => fold(o) && g.endsWith(fold(o)))) optionsOk++;
    }
  }
  return {
    expected: paper.expected.length,
    extracted: questions.length,
    found,
    falsePositives: questions.length - used.size,
    text: found ? textSum / found : null,
    options: optionsTotal ? optionsOk / optionsTotal : null,
  };
}

const root = process.argv[2];
const rows: any[] = [];
for (const strategy of readdirSync(root)) {
  const dir = join(root, strategy);
  for (const run of readdirSync(dir)) {
    const f = join(dir, run, 'detail.json');
    if (!existsSync(f)) continue;
    const d = JSON.parse(readFileSync(f, 'utf8'));
    const paperId = run.replace(/-r\d+$/, '');
    const calls = d.calls ?? [];
    const cost = calls.reduce((a: number, c: any) => a + c.costMillicents, 0) / 1000;
    const s = scoreRun(paperId, d.questions ?? []);
    rows.push({
      strategy,
      run,
      paper: paperId,
      cost,
      calls: calls.length,
      expensive: calls.filter((c: any) => c.model !== 'gpt-6-luna').length,
      high: calls.filter((c: any) => c.reasoningEffort === 'high').length,
      seconds: Math.round((d.row?.ms ?? 0) / 1000),
      ...s,
    });
  }
}
for (const r of rows.sort((a, b) => (a.strategy + a.run).localeCompare(b.strategy + b.run))) {
  console.log(
    [
      r.strategy.padEnd(16),
      r.run.padEnd(24),
      `${r.cost.toFixed(2)}¢`.padStart(7),
      `calls=${r.calls}`.padEnd(9),
      `exp=${r.expensive}`.padEnd(7),
      `high=${r.high}`.padEnd(7),
      `found=${r.found}/${r.expected}`.padEnd(10),
      `extracted=${r.extracted}`.padEnd(13),
      `falsePos=${r.falsePositives}`.padEnd(11),
      `text=${r.text?.toFixed(2) ?? '—'}`.padEnd(10),
      `opts=${r.options?.toFixed(2) ?? '—'}`.padEnd(10),
      `${r.seconds}s`,
    ].join(' '),
  );
}
console.log(JSON.stringify(rows));
