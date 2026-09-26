/**
 * Reactions in the classroom — a thumbs-up, applause, a laugh.
 *
 * Nothing is stored: a reaction is a moment, not a record. The gateway checks
 * the sender is in the classroom's socket room (which the membership check
 * already guarded), the emoji is one of the set the page offers, and the
 * sender has not been hammering the button — thirty students with a laugh
 * button is a room nobody can teach in.
 */
export const LIVE_REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '🤔'] as const;
export type LiveReaction = (typeof LIVE_REACTIONS)[number];

export function isReaction(x: unknown): x is LiveReaction {
  return typeof x === 'string' && (LIVE_REACTIONS as readonly string[]).includes(x);
}

/** A small burst is fine; a stream is not. */
export const REACTION_BURST = 5;
export const REACTION_WINDOW_MS = 5_000;

/** Per-user sliding window, per process (enough to bound one tab). */
export class ReactionLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(userId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < REACTION_WINDOW_MS);
    if (recent.length >= REACTION_BURST) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    if (this.hits.size > 20_000) this.hits.clear();
    return true;
  }
}
