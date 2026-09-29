import {
  IDLE_RESTART_MS,
  MAX_SEPARATE,
  planCut,
  planSources,
  STUDENT_MAX_MS,
  TEACHER_MAX_MS,
  TEACHER_MIN_BEFORE_TURN_MS,
  TURN_SILENCE_MS,
  type PieceClock,
} from './speakerCapture';
import { groupBySpeaker, hasSpeakers, speakerLabel } from './transcriptSpeakers';

const clock = (over: Partial<PieceClock> = {}): PieceClock => ({
  own: false,
  startedAt: 0,
  voicedMs: 0,
  lastVoiceAt: null,
  ...over,
});

describe('per-speaker capture: when a piece ends', () => {
  it("the teacher's piece runs three minutes, or yields to a student after 20 s", () => {
    const t = clock({ own: true, voicedMs: 10_000, lastVoiceAt: 1_000 });
    expect(planCut(t, TEACHER_MAX_MS - 1, false)).toBe('keep');
    expect(planCut(t, TEACHER_MAX_MS, false)).toBe('cut');
    // A student starts answering: the teacher's words so far are one piece…
    expect(planCut(t, TEACHER_MIN_BEFORE_TURN_MS, true)).toBe('cut');
    // …but never a tiny one.
    expect(planCut(t, TEACHER_MIN_BEFORE_TURN_MS - 1, true)).toBe('keep');
  });

  it("a student's turn ends after real speech and a pause, or at a minute", () => {
    // "نعم" (under 3 s of voice) and a pause: kept, never a 2-second call.
    expect(planCut(clock({ voicedMs: 1_200, lastVoiceAt: 2_000 }), 30_000, false)).toBe('keep');
    // An answer, then silence: the turn is over.
    const answer = clock({ voicedMs: 6_000, lastVoiceAt: 10_000 });
    expect(planCut(answer, 10_000 + TURN_SILENCE_MS - 1, false)).toBe('keep');
    expect(planCut(answer, 10_000 + TURN_SILENCE_MS, false)).toBe('cut');
    // A long answer is split, still whole minutes.
    expect(planCut(clock({ voicedMs: 50_000, lastVoiceAt: STUDENT_MAX_MS }), STUDENT_MAX_MS, false)).toBe('cut');
  });

  it('a piece that heard nothing is restarted, never sent', () => {
    expect(planCut(clock(), IDLE_RESTART_MS - 1, false)).toBe('keep');
    expect(planCut(clock(), IDLE_RESTART_MS, false)).toBe('restart');
    expect(planCut(clock({ own: true }), IDLE_RESTART_MS, true)).toBe('restart');
  });

  it('records the teacher first, keeps current speakers, mixes the overflow', () => {
    const mics = [
      ...Array.from({ length: MAX_SEPARATE + 1 }, (_, i) => ({ userId: `s${i}`, own: false })),
      { userId: 't', own: true },
    ];
    const plan = planSources(mics, ['s6']);
    expect(plan.separate[0]).toBe('t');
    expect(plan.separate).toContain('s6'); // already recorded: not moved mid-turn
    expect(plan.separate).toHaveLength(MAX_SEPARATE);
    expect(plan.mixed).toHaveLength(2);
    expect(plan.mixed).not.toContain('t');
  });
});

describe('transcript with speakers', () => {
  const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k);

  it('groups one microphone’s consecutive words; overlap starts its own turn', () => {
    const T = { kind: 'TEACHER' as const, name: 'أ. سارة' };
    const g = groupBySpeaker([
      { startSec: 0, durationSec: 60, text: 'a', speaker: T },
      { startSec: 60, durationSec: 60, text: 'b', speaker: T },
      { startSec: 120, durationSec: 10, text: 'c', speaker: { kind: 'STUDENT' as const, ordinal: 1 } },
      { startSec: 125, durationSec: 10, text: 'd', speaker: { kind: 'STUDENT' as const, self: true }, overlap: true },
      { startSec: 140, durationSec: 30, text: 'e', speaker: T },
    ]);
    expect(g.map((x) => x.segments.map((s) => s.text).join(''))).toEqual(['ab', 'c', 'd', 'e']);
    expect(g.map((x) => x.overlap)).toEqual([false, false, true, false]);
  });

  it('labels: you, student N, the teacher by name, unknown — never an id', () => {
    expect(speakerLabel(t, { kind: 'STUDENT', self: true })).toBe('record.transcript.speaker.you');
    expect(speakerLabel(t, { kind: 'STUDENT', ordinal: 2 })).toBe('record.transcript.speaker.student:{"n":2}');
    expect(speakerLabel(t, { kind: 'TEACHER', name: 'أ. سارة' })).toBe('أ. سارة');
    expect(speakerLabel(t, { kind: 'UNKNOWN' })).toBe('record.transcript.speaker.unknown');
    expect(speakerLabel(t, undefined)).toBe('record.transcript.speaker.unknown');
  });

  it('an older transcript has no speakers and keeps the plain view', () => {
    expect(hasSpeakers([{ startSec: 0, durationSec: 180, text: 'x' }])).toBe(false);
    expect(hasSpeakers([{ startSec: null, durationSec: null, text: 'x' }])).toBe(false);
  });
});

// ── Cost: the same class, captured mixed and per speaker ───────────────────
//
// A fake class timeline run through the real cut rule (planCut) and the mixed
// capture's rule (3-minute pieces, sent when any voice was heard). What an
// STT provider would bill is the length of every piece sent.

type Voice = { who: string; from: number; to: number };
const TICK = 400;

function simulate(minutes: number, voices: Voice[], micOpen: { who: string; from: number; to: number }[]) {
  const end = minutes * 60_000;
  const talking = (who: string, at: number) => voices.some((v) => v.who === who && at >= v.from && at < v.to);
  const open = (who: string, at: number) => who === 't' || micOpen.some((m) => m.who === who && at >= m.from && at < m.to);
  const people = ['t', ...new Set(micOpen.map((m) => m.who))];

  // Mixed
  let mixedPieces = 0;
  let mixedMs = 0;
  for (let s = 0; s < end; s += 180_000) {
    const e = Math.min(end, s + 180_000);
    let voiced = false;
    for (let at = s; at < e; at += TICK) if (people.some((p) => open(p, at) && talking(p, at))) voiced = true;
    if (voiced) {
      mixedPieces++;
      mixedMs += e - s;
    }
  }

  // Per speaker
  const pieces: { who: string; ms: number }[] = [];
  const cur = new Map<string, PieceClock>();
  const close = (who: string, at: number) => {
    const p = cur.get(who)!;
    if (p.voicedMs > 0) pieces.push({ who, ms: at - p.startedAt });
    cur.delete(who);
  };
  for (let at = 0; at < end; at += TICK) {
    for (const p of people) {
      if (open(p, at) && !cur.has(p)) cur.set(p, { own: p === 't', startedAt: at, voicedMs: 0, lastVoiceAt: null });
      if (!open(p, at) && cur.has(p)) close(p, at); // the track ends: the turn ends
    }
    for (const [p, c] of cur) {
      if (talking(p, at)) {
        c.voicedMs += TICK;
        c.lastVoiceAt = at;
      }
    }
    for (const [p, c] of [...cur]) {
      const others = [...cur.keys()].some((o) => o !== p && talking(o, at));
      const d = planCut(c, at, others);
      if (d === 'keep') continue;
      if (d === 'cut') close(p, at);
      else cur.delete(p);
      cur.set(p, { own: p === 't', startedAt: at, voicedMs: 0, lastVoiceAt: null });
    }
  }
  for (const p of [...cur.keys()]) close(p, end);
  const speakerMs = pieces.reduce((a, p) => a + p.ms, 0);
  return {
    mixed: { pieces: mixedPieces, billedMin: +(mixedMs / 60_000).toFixed(1) },
    perSpeaker: {
      pieces: pieces.length,
      studentPieces: pieces.filter((p) => p.who !== 't').length,
      billedMin: +(speakerMs / 60_000).toFixed(1),
      shortestStudentSec: Math.min(...pieces.filter((p) => p.who !== 't').map((p) => p.ms / 1000)),
    },
  };
}

describe('per-speaker capture: cost against the mixed capture (fake STT)', () => {
  it('a 45-minute class with 12 student turns stays within ~1.3× the billed minutes', () => {
    const min = 60_000;
    const voices: Voice[] = [];
    const micOpen: { who: string; from: number; to: number }[] = [];
    // The teacher talks in 50-second stretches with 10-second pauses.
    for (let s = 0; s < 45 * min; s += 60_000) voices.push({ who: 't', from: s, to: s + 50_000 });
    // Twelve answers, 4–25 s each, the microphone open a few seconds around them.
    const turns = [4, 8, 25, 6, 12, 5, 18, 9, 4, 15, 7, 10];
    turns.forEach((sec, i) => {
      const who = `s${i % 4}`;
      const at = (3 + i * 3.5) * min + 51_000; // in the teacher's pause
      micOpen.push({ who, from: at - 2_000, to: at + sec * 1000 + 3_000 });
      voices.push({ who, from: at, to: at + sec * 1000 });
    });
    // Two students answering at once.
    micOpen.push({ who: 's3', from: 20 * min + 51_000, to: 20 * min + 62_000 });
    voices.push({ who: 's3', from: 20 * min + 52_000, to: 20 * min + 58_000 });

    const r = simulate(45, voices, micOpen);
    // eslint-disable-next-line no-console
    console.log('cost simulation', JSON.stringify(r));
    expect(r.perSpeaker.studentPieces).toBeGreaterThanOrEqual(12);
    expect(r.perSpeaker.studentPieces).toBeLessThanOrEqual(16);
    // No two-second calls: every student piece is the whole open microphone.
    expect(r.perSpeaker.shortestStudentSec).toBeGreaterThanOrEqual(8);
    expect(r.perSpeaker.billedMin).toBeLessThanOrEqual(r.mixed.billedMin * 1.3);
  });
});
