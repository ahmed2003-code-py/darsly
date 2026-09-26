#!/usr/bin/env node
/**
 * Arabic lesson transcription benchmark — Checkpoint B.6 harness.
 *
 * STATUS: ARABIC BENCHMARK PENDING INPUT (B.6 harness, extended in B.7 with
 * English-term, number, Arabic-word and punctuation scores; see metrics.mjs). Nothing has been run: it needs real
 * Egyptian-Arabic lesson audio with human reference transcripts, and every
 * run is paid (OpenAI and Deepgram bill per audio minute). It refuses to run
 * without both an input directory and --confirm-paid.
 *
 * Why it exists: Cloudflare Realtime carries media only, so a Darsly-hosted
 * class has no provider transcript (Daily had Deepgram built in). The
 * transcript for the lesson summary will come from Darsly's own recording.
 * This compares the candidates on what matters for that choice — accuracy on
 * Egyptian Arabic classroom speech, speaker separation, speed and cost.
 *
 * Candidates:
 *   openai:gpt-4o-mini-transcribe     (POST /v1/audio/transcriptions)
 *   openai:gpt-4o-transcribe-diarize  (POST /v1/audio/transcriptions, diarized_json)
 *   deepgram:nova-3                   (POST /v1/listen?model=nova-3&language=ar)
 *
 * Input directory layout:
 *   <dir>/<name>.(mp3|m4a|wav|webm)   the audio (a lesson excerpt)
 *   <dir>/<name>.txt                  the human reference transcript
 *
 * Usage:
 *   OPENAI_API_KEY=... DEEPGRAM_API_KEY=... \
 *   node scripts/transcription-bench/bench.mjs --in ./bench-audio --confirm-paid [--only deepgram:nova-3]
 *
 * Each file may also have <name>.notes.txt (speaker count, dialect, topic)
 * for the write-up; it is not scored.
 *
 * Output: a table per file and overall — WER and CER against the reference
 * (Arabic-normalised: diacritics, tatweel and alef/yaa/taa-marbuta forms
 * folded), wall-clock time, and cost from each provider's published per-minute
 * price (edit PRICES below if they change). Results are written to
 * <dir>/results-<timestamp>.json. Keys are read from the environment only and
 * never printed.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scoreAll } from './metrics.mjs';

/** USD per audio minute — OFFICIAL list prices at the time of writing; verify before relying on them. */
const PRICES = {
  'openai:gpt-4o-mini-transcribe': 0.003,
  'openai:gpt-4o-transcribe-diarize': 0.006,
  'deepgram:nova-3': 0.0043,
};

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = arg('--in');
const only = arg('--only');
if (!dir || !args.includes('--confirm-paid')) {
  console.error(
    'ARABIC BENCHMARK PENDING INPUT — refusing to run.\n' +
      'Needs --in <dir with audio + reference .txt> and --confirm-paid (every run is billed).',
  );
  process.exit(2);
}

// ── Providers ────────────────────────────────────────────────────────────────
async function openai(model, file) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', new Blob([readFileSync(file)]), basename(file));
  form.append('model', model);
  form.append('language', 'ar');
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
const CANDIDATES = {
  'openai:gpt-4o-mini-transcribe': (f) => openai('gpt-4o-mini-transcribe', f),
  'openai:gpt-4o-transcribe-diarize': (f) => openai('gpt-4o-transcribe-diarize', f),
  'deepgram:nova-3': (f) => deepgram(f),
};

function durationMin(file) {
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8' },
    );
    return Number(out.trim()) / 60;
  } catch {
    return null;
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
const audio = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|webm)$/i.test(f));
const results = [];
for (const a of audio) {
  const file = join(dir, a);
  const refFile = join(dir, basename(a, extname(a)) + '.txt');
  let ref;
  try {
    statSync(refFile);
    ref = readFileSync(refFile, 'utf8');
  } catch {
    console.warn(`skip ${a}: no reference ${basename(refFile)}`);
    continue;
  }
  const mins = durationMin(file);
  for (const [name, run] of Object.entries(CANDIDATES)) {
    if (only && name !== only) continue;
    const t0 = Date.now();
    try {
      const out = await run(file);
      const row = {
        file: a,
        provider: name,
        minutes: mins,
        ...scoreAll(ref, out.text),
        speakers: out.speakers,
        timestamps: out.timestamps,
        seconds: (Date.now() - t0) / 1000,
        usd: mins != null ? +(mins * PRICES[name]).toFixed(5) : null,
        usdPerHour: +(PRICES[name] * 60).toFixed(3),
        realtimeFactor: mins ? +((Date.now() - t0) / 1000 / (mins * 60)).toFixed(3) : null,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    } catch (e) {
      results.push({ file: a, provider: name, error: String(e.message ?? e) });
      console.error(`${a} ${name}: ${e.message ?? e}`);
    }
  }
}
const byProvider = {};
for (const r of results.filter((x) => !x.error)) (byProvider[r.provider] ||= []).push(r);
const summary = Object.fromEntries(
  Object.entries(byProvider).map(([p, rs]) => {
    const mins = rs.reduce((n, r) => n + (r.minutes ?? 0), 0);
    const w = (k) => rs.reduce((n, r) => n + r[k] * (r.minutes ?? 1), 0) / Math.max(1e-9, mins || rs.length);
    const avg = (k) => {
      const xs = rs.map((r) => r[k]).filter((x) => x != null);
      return xs.length ? +(xs.reduce((n, x) => n + x, 0) / xs.length).toFixed(4) : null;
    };
    return [p, {
      files: rs.length, minutes: +mins.toFixed(2),
      wer: +w('wer').toFixed(4), cer: +w('cer').toFixed(4),
      arabicWordRecall: avg('arabicWordRecall'), englishTermRecall: avg('englishTermRecall'),
      numberRecall: avg('numberRecall'), punctuationRatio: avg('punctuationRatio'),
      realtimeFactor: avg('realtimeFactor'), usdPerHour: rs[0].usdPerHour,
      usd: +rs.reduce((n, r) => n + (r.usd ?? 0), 0).toFixed(4),
    }];
  }),
);
console.table(summary);
const outFile = join(dir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
console.log(`written ${outFile}`);
