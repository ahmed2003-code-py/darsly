/**
 * "Your microphone is muted on your device" — told from the sound itself.
 *
 * A laptop's mute key (or the system's mute) does not end the browser's
 * microphone track, and Chrome on Windows fires no event for it: the track
 * keeps running and carries exact digital silence. A real microphone in a
 * quiet room never does — there is always a noise floor — so a run of
 * samples that are all exactly zero is the device's mute, and the first
 * non-zero sample is it being unmuted.
 *
 * Judged only while the track is enabled (our own mute also sends zeros) and
 * the audio context runs (a suspended context reads zeros too); the caller
 * passes `null` for "cannot judge now", which never changes the verdict.
 */
export const DEVICE_MUTE_AFTER_MS = 2_000;

export class DeviceMuteJudge {
  private silentSince: number | null = null;
  muted = false;

  /** One reading: the loudest absolute sample since the last one, or null. Returns the verdict. */
  feed(peak: number | null, now: number): boolean {
    if (peak === null) {
      this.silentSince = null;
      return this.muted;
    }
    if (peak > 0) {
      this.silentSince = null;
      this.muted = false;
      return false;
    }
    this.silentSince ??= now;
    if (now - this.silentSince >= DEVICE_MUTE_AFTER_MS) this.muted = true;
    return this.muted;
  }

  reset(): void {
    this.silentSince = null;
    this.muted = false;
  }
}

/** The loudest absolute sample of one analyser read. */
export function peakOf(samples: Float32Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > m) m = v;
  }
  return m;
}
