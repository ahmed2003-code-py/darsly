/**
 * The classroom's small sounds: someone joined or left, a hand went up, a
 * message arrived. Synthesised on the spot (two short sine notes) rather than
 * loaded, so there is nothing to download and nothing to fail, and kept quiet
 * — a lesson is being taught over them.
 *
 * Muting is remembered on this device (a convenience, nothing more). Sounds
 * of the same kind are spaced out, so thirty students arriving at the start
 * of class is one chime, not thirty.
 */
export type LiveSound = 'join' | 'leave' | 'hand' | 'message';

const KEY = 'darsly-live-sounds';
const MIN_GAP_MS: Record<LiveSound, number> = { join: 4000, leave: 4000, hand: 1500, message: 1200 };
/** Two notes each: [frequency Hz, start s, length s]. */
const NOTES: Record<LiveSound, [number, number, number][]> = {
  join: [
    [660, 0, 0.12],
    [880, 0.1, 0.16],
  ],
  leave: [
    [700, 0, 0.12],
    [520, 0.1, 0.16],
  ],
  hand: [
    [988, 0, 0.1],
    [1318, 0.09, 0.18],
  ],
  message: [[784, 0, 0.09]],
};

let ctx: AudioContext | null = null;
const last: Partial<Record<LiveSound, number>> = {};

export function soundsMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === 'off';
  } catch {
    return false;
  }
}

export function setSoundsMuted(muted: boolean) {
  try {
    localStorage.setItem(KEY, muted ? 'off' : 'on');
  } catch {
    /* the choice lasts for this page only */
  }
}

export function playLiveSound(kind: LiveSound, now = Date.now()) {
  if (soundsMuted()) return;
  if (now - (last[kind] ?? 0) < MIN_GAP_MS[kind]) return;
  last[kind] = now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, start, len] of NOTES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // A soft attack and a quick fade: a chime, not a beep.
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(0.06, t0 + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.02);
    }
  } catch {
    /* no audio here: the class goes on silently */
  }
}
