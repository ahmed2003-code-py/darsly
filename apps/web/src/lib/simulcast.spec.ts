import {
  initialLayer,
  MIN_SWITCH_GAP_MS,
  nextLayer,
  UP_AFTER_MAX_MS,
  UP_AFTER_MS,
  type LayerSample,
} from './simulcast';

const clean: LayerSample = { lossPct: 0, freezes: 0, incomingKbps: null };
const lossy: LayerSample = { lossPct: 8, freezes: 0, incomingKbps: null };
const S = 1000;

/** Feed samples every 4s from `from`, return the final state and the time. */
function run(start: ReturnType<typeof initialLayer>, from: number, samples: LayerSample[]) {
  let s = start;
  let t = from;
  for (const x of samples) {
    t += 4 * S;
    s = nextLayer(s, x, t);
  }
  return { s, t };
}

describe('simulcast layer choice', () => {
  it('stays on the sharp layer while the link is clean', () => {
    const { s } = run(initialLayer(0), 0, Array(20).fill(clean));
    expect(s.rid).toBe('h');
  });

  it('steps down at once on loss, a freeze, or a thin estimate', () => {
    const at = MIN_SWITCH_GAP_MS;
    expect(nextLayer(initialLayer(0), lossy, at).rid).toBe('l');
    expect(nextLayer(initialLayer(0), { ...clean, freezes: 1 }, at).rid).toBe('l');
    expect(nextLayer(initialLayer(0), { ...clean, incomingKbps: 600 }, at).rid).toBe('l');
  });

  it('never switches twice in a few seconds', () => {
    const s = nextLayer(initialLayer(0), lossy, 2 * S);
    expect(s.rid).toBe('h');
  });

  it('comes back up only after the link has stayed clean long enough', () => {
    const down = nextLayer(initialLayer(0), lossy, 10 * S);
    expect(down.rid).toBe('l');
    // 20s clean: not yet.
    let r = run(down, 10 * S, Array(5).fill(clean));
    expect(r.s.rid).toBe('l');
    // A bad sample resets the clock.
    r = run(r.s, r.t, [lossy]);
    expect(r.s.goodSince).toBeNull();
    r = run(r.s, r.t, Array(Math.ceil(UP_AFTER_MS / (4 * S)) + 1).fill(clean));
    expect(r.s.rid).toBe('h');
  });

  it('waits longer each time an upgrade does not hold, up to a cap', () => {
    let s = nextLayer(initialLayer(0), lossy, 10 * S);
    let t = 10 * S;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Clean until it goes up…
      while (s.rid === 'l') {
        t += 4 * S;
        s = nextLayer(s, clean, t);
      }
      // …then immediately bad again.
      t += MIN_SWITCH_GAP_MS;
      s = nextLayer(s, lossy, t);
      expect(s.rid).toBe('l');
      waits.push(s.upAfterMs);
    }
    expect(waits[0]).toBe(UP_AFTER_MS * 2);
    expect(waits[1]).toBe(UP_AFTER_MS * 4);
    expect(Math.max(...waits)).toBe(UP_AFTER_MAX_MS);
  });

  it('does not go up on a link whose estimate is too thin for the sharp layer', () => {
    const down = nextLayer(initialLayer(0), lossy, 10 * S);
    const { s } = run(down, 10 * S, Array(30).fill({ ...clean, incomingKbps: 1000 }));
    expect(s.rid).toBe('l');
  });
});
