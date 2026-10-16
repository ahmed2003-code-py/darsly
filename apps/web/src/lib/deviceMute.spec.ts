import { DEVICE_MUTE_AFTER_MS, DeviceMuteJudge, peakOf } from './deviceMute';

describe('a microphone muted on the device', () => {
  it('exact silence for long enough is the device mute; one sound ends it', () => {
    const j = new DeviceMuteJudge();
    expect(j.feed(0, 0)).toBe(false);
    expect(j.feed(0, DEVICE_MUTE_AFTER_MS - 1)).toBe(false);
    expect(j.feed(0, DEVICE_MUTE_AFTER_MS)).toBe(true);
    expect(j.feed(0.0001, DEVICE_MUTE_AFTER_MS + 100)).toBe(false);
  });

  it('a quiet room is not a mute: any noise floor keeps it live', () => {
    const j = new DeviceMuteJudge();
    for (let t = 0; t < 10_000; t += 250) expect(j.feed(0.00003, t)).toBe(false);
  });

  it('"cannot judge now" (our own mute, a suspended context) never decides', () => {
    const j = new DeviceMuteJudge();
    j.feed(0, 0);
    expect(j.feed(null, 1_500)).toBe(false);
    // The silence run started over after the gap.
    expect(j.feed(0, 2_500)).toBe(false);
    expect(j.feed(0, 2_500 + DEVICE_MUTE_AFTER_MS)).toBe(true);
    // Already muted: a gap keeps the verdict, it does not clear it.
    expect(j.feed(null, 9_000)).toBe(true);
  });

  it('reset clears the verdict (a new microphone)', () => {
    const j = new DeviceMuteJudge();
    j.feed(0, 0);
    j.feed(0, DEVICE_MUTE_AFTER_MS);
    j.reset();
    expect(j.muted).toBe(false);
  });

  it('peakOf reads the loudest sample, either sign', () => {
    expect(peakOf(new Float32Array([0, -0.5, 0.25]))).toBe(0.5);
    expect(peakOf(new Float32Array(128))).toBe(0);
  });
});
