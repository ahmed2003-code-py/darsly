#!/usr/bin/env node
/**
 * Arabic lesson transcription benchmark — Checkpoint C.
 *
 * STATUS: ARABIC BENCHMARK BLOCKED — NEEDS REAL AUDIO + PRODUCT OWNER APPROVAL.
 * Every real run is billed per audio minute. It refuses to run without an
 * input directory and --confirm-paid; `--dry-run` checks the inputs and
 * prints the plan and its cost without calling anyone.
 *
 * What it measures is what production does (LIVE_TRANSCRIBE):
 *   - the audio is cut the way the teacher's page cuts it: independent
 *     3-minute pieces, Opus in WebM, 32 kbps mono (`--whole` sends the file
 *     in one go instead, for comparison);
 *   - each piece is sent with language=ar and the lesson title as `prompt`
 *     (`--title "…"`, or <name>.title.txt beside the audio);
 *   - the pieces' text is joined in order.
 *
 * Candidates (default: the two the integration supports):
 *   openai:gpt-4o-mini-transcribe      (the configured default, LIVE_STT_MODEL)
 *   openai:gpt-4o-transcribe
 *   openai:gpt-4o-transcribe-diarize   (--diarize; speaker separation, whole file only)
 *   deepgram:nova-3                    (--deepgram; another vendor — reference only)
 *
 * Input directory:
 *   <dir>/<name>.(mp3|m4a|wav|webm|ogg)  a 5–10 minute Egyptian classroom excerpt
 *   <dir>/<name>.txt                     the human reference transcript
 *   <dir>/<name>.title.txt               optional: the lesson title (the prompt)
 *
 * Usage:
 *   node scripts/transcription-bench/bench.mjs --in ./bench-audio --dry-run
 *   OPENAI_API_KEY=… node scripts/transcription-bench/bench.mjs --in ./bench-audio --confirm-paid
 *
 * Scores per file and overall (metrics.mjs): WER, CER (Arabic-normalised),
 * Arabic-word recall, Egyptian-dialect recall, English-term recall, number
 * recall, punctuation ratio; plus timestamps/speakers when the output has
 * them, wall-clock latency, real-time factor, cost and cost per hour at the
 * published per-minute price. Results go to <dir>/results-<timestamp>.json
 * (transcripts included, so a person can read them side by side). Keys are
 * read from the environment only and never printed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scoreAll } from './metrics.mjs';

/** USD per audio minute — OFFICIAL list prices at the time of writing; verify before relying on them. */
export const PRICES = {
  'openai:gpt-4o-mini-transcribe': 0.003,
  'openai:gpt-4o-transcribe': 0.006,
  'openai:gpt-4o-transcribe-diarize': 0.006,
  'deepgram:nova-3': 0.0043,
};
const PIECE_SEC = 180;

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k) => args.includes(k);
const dir = arg('--in');
const dry = has('--dry-run');
const whole = has('--whole');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE ?? 'ffprobe';
const candidates = [
  'openai:gpt-4o-mini-transcribe',
  'openai:gpt-4o-transcribe',
  ...(has('--diarize') ? ['openai:gpt-4o-transcribe-diarize'] : []),
  ...(has('--deepgram') ? ['deepgram:nova-3'] : []),
].filter((c) => !arg('--only') || arg('--only').split(',').includes(c));

if (!dir || (!dry && !has('--confirm-paid'))) {
  console.error(
    'ARABIC BENCHMARK BLOCKED — NEEDS REAL AUDIO + PRODUCT OWNER APPROVAL. Refusing to run.\n' +
      'Needs --in <dir with audio + reference .txt>, and --confirm-paid (every run is billed),\n' +
      'or --dry-run to check the inputs and see the plan and cost without any call.',
  );
  process.exit(2);
}

// ── Providers ────────────────────────────────────────────────────────────────
async function openai(model, file, prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)]), basename(file));
  form.append('model', model);
  form.append('language', 'ar');
  if (prompt && !model.includes('diarize')) form.append('prompt', prompt.slice(0, 400));
  if (model.includes('diarize')) {
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
  }
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) throw new Error(`openai ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.text ?? (j.segments ?? []).map((s) => s.text).join(' ');
  const speakers = j.segments ? new Set(j.segments.map((s) => s.speaker)).size : null;
  return { text, speakers, timestamps: Array.isArray(j.segments) && j.segments.some((s) => s.start != null) };
}
async function deepgram(file) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY not set');
  const r = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&language=ar&punctuate=true&diarize=true&smart_format=true',
    {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/octet-stream' },
      body: readFileSync(file),
    },
  );
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const alt = j.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const speakers = alt.words ? new Set(alt.words.map((w) => w.speaker)).size : null;
  return { text: alt.transcript ?? '', speakers, timestamps: !!alt.words?.some((w) => w.start != null) };
}
const run = (name, file, prompt) =>
  name === 'deepgram:nova-3' ? deepgram(file) : openai(name.slice('openai:'.length), file, prompt);

function durationMin(file) {
  try {
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
      encoding: 'utf8',
    });
    return Number(out.trim()) / 60;
  } catch {
    return null;
  }
}

/** The production cut: independent 3-minute Opus/WebM pieces at 32 kbps mono. */
function pieces(file, work) {
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(PIECE_SEC), '-reset_timestamps', '1', join(work, 'p%04d.webm'),
  ]);
  return readdirSync(work).filter((f) => /^p\d+\.webm$/.test(f)).sort().map((f) => join(work, f));
}

// ── Run ──────────────────────────────────────────────────────────────────────
const audio = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|webm|ogg)$/i.test(f));
const plan = [];
for (const a of audio) {
  const file = join(dir, a);
  const stem = basename(a, extname(a));
  const refFile = join(dir, `${stem}.txt`);
  const titleFile = join(dir, `${stem}.title.txt`);
  if (!existsSync(refFile)) {
    console.warn(`skip ${a}: no reference ${basename(refFile)}`);
    continue;
  }
  plan.push({
    a,
    file,
    ref: readFileSync(refFile, 'utf8'),
    title: arg('--title') ?? (existsSync(titleFile) ? readFileSync(titleFile, 'utf8').trim() : ''),
    mins: durationMin(file),
  });
}
if (!plan.length) {
  console.error('No audio with a reference transcript in', dir);
  process.exit(2);
}
const totalMin = plan.reduce((n, p) => n + (p.mins ?? 0), 0);
console.log(
  `plan: ${plan.length} file(s), ${totalMin.toFixed(1)} audio min, ${whole ? 'whole files' : `${PIECE_SEC}s production pieces`}, candidates: ${candidates.join(', ')}`,
);
for (const c of candidates) {
  console.log(`  ${c}: ~$${(totalMin * PRICES[c]).toFixed(4)} for this run, $${(PRICES[c] * 60).toFixed(2)} per lesson hour`);
}
if (dry) {
  for (const p of plan) {
    const work = mkdtempSync(join(tmpdir(), 'bench-'));
    try {
      const n = whole ? 1 : pieces(p.file, work).length;
      console.log(`  ${p.a}: ${p.mins?.toFixed(2) ?? '?'} min → ${n} piece(s); reference ${p.ref.length} chars; prompt "${p.title}"`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  console.log('DRY RUN — no provider was called, nothing was billed.');
  process.exit(0);
}

const results = [];
for (const p of plan) {
  const work = mkdtempSync(join(tmpdir(), 'bench-'));
  try {
    const parts = whole ? [p.file] : pieces(p.file, work);
    for (const name of candidates) {
      const t0 = Date.now();
      try {
        // Diarization needs the whole conversation to tell speakers apart.
        const files = name.includes('diarize') || name.startsWith('deepgram') ? [p.file] : parts;
        const outs = [];
        for (const f of files) outs.push(await run(name, f, p.title));
        const text = outs.map((o) => o.text.trim()).filter(Boolean).join('\n');
        const secs = (Date.now() - t0) / 1000;
        const row = {
          file: p.a,
          provider: name,
          pieces: files.length,
          minutes: p.mins,
          ...scoreAll(p.ref, text),
          speakers: outs[0]?.speakers ?? null,
          timestamps: outs.some((o) => o.timestamps),
          seconds: secs,
          realtimeFactor: p.mins ? +(secs / (p.mins * 60)).toFixed(3) : null,
          usd: p.mins != null ? +(p.mins * PRICES[name]).toFixed(5) : null,
          usdPerHour: +(PRICES[name] * 60).toFixed(3),
          text,
        };
        results.push(row);
        const { text: _t, ...shown } = row;
        console.log(JSON.stringify(shown));
      } catch (e) {
        results.push({ file: p.a, provider: name, error: String(e.message ?? e) });
        console.error(`${p.a} ${name}: ${e.message ?? e}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const byProvider = {};
for (const r of results.filter((x) => !x.error)) (byProvider[r.provider] ||= []).push(r);
const summary = Object.fromEntries(
  Object.entries(byProvider).map(([prov, rs]) => {
    const mins = rs.reduce((n, r) => n + (r.minutes ?? 0), 0);
    const w = (k) => rs.reduce((n, r) => n + r[k] * (r.minutes ?? 1), 0) / Math.max(1e-9, mins || rs.length);
    const avg = (k) => {
      const xs = rs.map((r) => r[k]).filter((x) => x != null);
      return xs.length ? +(xs.reduce((n, x) => n + x, 0) / xs.length).toFixed(4) : null;
    };
    return [prov, {
      files: rs.length, minutes: +mins.toFixed(2),
      wer: +w('wer').toFixed(4), cer: +w('cer').toFixed(4),
      arabicWordRecall: avg('arabicWordRecall'), dialectRecall: avg('dialectRecall'),
      englishTermRecall: avg('englishTermRecall'), numberRecall: avg('numberRecall'),
      punctuationRatio: avg('punctuationRatio'), realtimeFactor: avg('realtimeFactor'),
      usdPerHour: rs[0].usdPerHour, usd: +rs.reduce((n, r) => n + (r.usd ?? 0), 0).toFixed(4),
    }];
  }),
);
console.table(summary);
const outFile = join(dir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
console.log(`written ${outFile}`);
