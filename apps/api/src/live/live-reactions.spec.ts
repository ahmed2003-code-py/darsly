import { isReaction, LIVE_REACTIONS, REACTION_BURST, ReactionLimiter } from './live-reactions';

describe('classroom reactions', () => {
  it('accepts only the offered emoji', () => {
    for (const e of LIVE_REACTIONS) expect(isReaction(e)).toBe(true);
    expect(isReaction('💩')).toBe(false);
    expect(isReaction('<script>')).toBe(false);
    expect(isReaction(undefined)).toBe(false);
  });

  it('lets a burst through and stops a stream, per person', () => {
    const l = new ReactionLimiter();
    const t = 1_000_000;
    for (let i = 0; i < REACTION_BURST; i++) expect(l.allow('a', t + i)).toBe(true);
    expect(l.allow('a', t + 10)).toBe(false);
    // Someone else is not held back by it.
    expect(l.allow('b', t + 10)).toBe(true);
    // A little later the window has moved on.
    expect(l.allow('a', t + 6_000)).toBe(true);
  });
});
