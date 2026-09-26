/**
 * Whether a paid seat's replay rights still cover watching the recording now.
 *
 * Only the purchase's FROZEN policy is read — a teacher changing the
 * session's replay policy later changes nothing for seats already sold. On
 * top of this, the teacher must still have shared the recording
 * (recordingVisibility = STUDENTS): a paid seat never forces a recording out.
 *
 * A free booking (no purchase) is not judged here — it keeps the rules it
 * always had. A purchase that was cancelled or refunded has no booking, so it
 * never gets this far; the status check below is the second lock on that door.
 */
export type ReplayVerdict = { ok: true } | { ok: false; reason: string };

export const REPLAY_PURCHASE_STATES = new Set(['CONFIRMED', 'DELIVERED', 'NEEDS_REVIEW']);

export function paidReplayVerdict(
  purchase: { status: string; replayPolicy: string; replayDays: number | null } | null,
  session: { startsAt: Date; durationMin: number; endedAt: Date | null },
  now = Date.now(),
): ReplayVerdict {
  if (!purchase) return { ok: true };
  if (!REPLAY_PURCHASE_STATES.has(purchase.status)) return { ok: false, reason: 'purchase not active' };
  if (purchase.replayPolicy === 'NONE') return { ok: false, reason: 'replay not included' };
  if (purchase.replayPolicy === 'INCLUDED_DAYS') {
    const end = session.endedAt?.getTime() ?? session.startsAt.getTime() + session.durationMin * 60_000;
    const until = end + (purchase.replayDays ?? 0) * 86_400_000;
    if (now > until) return { ok: false, reason: 'replay window over' };
  }
  return { ok: true };
}
