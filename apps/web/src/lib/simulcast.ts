/**
 * Which layer of the teacher's camera a student receives.
 *
 * The teacher sends two: `h` (720p, up to 1.2 Mbps) and `l` (a quarter of the
 * size, up to 150 kbps). A student on a weak link — a phone on a crowded
 * network, the usual case — is better served by a small picture that moves
 * than a sharp one that freezes, and the teacher's voice and screen do not
 * depend on it. So the page watches what actually arrives and chooses:
 *
 *  - step down at once when it goes wrong (loss, a freeze, a thin estimate);
 *  - step back up only after the link has been clean for a while, and wait
 *    longer each time an upgrade had to be undone, so a link on the edge does
 *    not flap between the two every few seconds.
 */
export type Rid = 'h' | 'l';

export interface LayerSample {
  /** Packet loss over the last window, percent. */
  lossPct: number;
  /** New freezes over the last window. */
  freezes: number;
  /** The browser's estimate of what the link can bring in, when it gives one. */
  incomingKbps: number | null;
}

export interface LayerState {
  rid: Rid;
  /** When the link started looking good enough to go back up. */
  goodSince: number | null;
  lastSwitch: number;
  /** When it last went back up (null: never) — to tell whether an upgrade held. */
  lastUpAt: number | null;
  /** How long it must stay good before an upgrade; doubles after a failed one. */
  upAfterMs: number;
}

export const DOWN_LOSS_PCT = 5;
export const UP_LOSS_PCT = 1;
export const DOWN_BELOW_KBPS = 900;
export const UP_ABOVE_KBPS = 1500;
export const UP_AFTER_MS = 30_000;
export const UP_AFTER_MAX_MS = 5 * 60_000;
/** An upgrade undone within this did not hold. */
export const UPGRADE_HOLD_MS = 30_000;
/** Never switch twice within this: the layer needs a moment to show its effect. */
export const MIN_SWITCH_GAP_MS = 8_000;

export function initialLayer(now: number): LayerState {
  return { rid: 'h', goodSince: null, lastSwitch: now, lastUpAt: null, upAfterMs: UP_AFTER_MS };
}

export function nextLayer(s: LayerState, x: LayerSample, now: number): LayerState {
  const bad =
    x.lossPct >= DOWN_LOSS_PCT ||
    x.freezes > 0 ||
    (x.incomingKbps != null && x.incomingKbps < DOWN_BELOW_KBPS);
  const good =
    x.lossPct < UP_LOSS_PCT &&
    x.freezes === 0 &&
    (x.incomingKbps == null || x.incomingKbps >= UP_ABOVE_KBPS);
  const settled = now - s.lastSwitch >= MIN_SWITCH_GAP_MS;

  if (s.rid === 'h') {
    if (bad && settled) {
      // Going down soon after going up means the upgrade did not hold:
      // wait twice as long before the next one.
      const failedUp = s.lastUpAt != null && now - s.lastUpAt < UPGRADE_HOLD_MS;
      return {
        rid: 'l',
        goodSince: null,
        lastSwitch: now,
        lastUpAt: s.lastUpAt,
        upAfterMs: failedUp ? Math.min(s.upAfterMs * 2, UP_AFTER_MAX_MS) : s.upAfterMs,
      };
    }
    return s;
  }
  const goodSince = good ? (s.goodSince ?? now) : null;
  if (good && settled && goodSince != null && now - goodSince >= s.upAfterMs) {
    return { rid: 'h', goodSince: null, lastSwitch: now, lastUpAt: now, upAfterMs: s.upAfterMs };
  }
  return goodSince === s.goodSince ? s : { ...s, goodSince };
}
