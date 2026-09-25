/**
 * The clocks of a live class, and the only place they are worked out.
 *
 *  - **session end** — `startsAt + durationMin` (an extension raises
 *    durationMin). Darsly's authority: joining closes, attendance stops
 *    counting, and the class is ended — by the teacher, or by the end sweep
 *    (LiveEndWorker), which closes the Daily room at that moment.
 *  - **room expiry** — a provider *safety TTL*, not the way a class ends. Set
 *    once, when the room is created, beyond any end the session could ever
 *    reach: `startsAt + LIVE_MAX_DURATION_MIN + ROOM_SAFETY_BUFFER_MIN`. It
 *    exists so a room Darsly somehow failed to close cannot live for ever.
 *    It is never moved: Daily fixes each participant's `eject_at_room_exp`
 *    when they join, and changing the room's `exp` afterwards does not move
 *    it (observed against the real account, 2026-09-25) — so an expiry near
 *    the class's end would eject people from a class that was extended.
 *  - **token expiry** — session end + TOKEN_GRACE_MIN. Governs *joining*
 *    only: tokens carry no `eject_at_token_exp`.
 *
 * Invariant: room expiry > every end a valid session can have, because
 * durationMin is capped at LIVE_MAX_DURATION_MIN everywhere it is set.
 */

/** A live session is a class, not a broadcast station: 12 hours is the ceiling. */
export const LIVE_MAX_DURATION_MIN = 720;
/** How far past the longest possible class the provider's own TTL sits. */
export const ROOM_SAFETY_BUFFER_MIN = 30;
/** Long enough to rejoin near the end, short enough to be worth little if stolen. */
export const TOKEN_GRACE_MIN = 30;

export function roomSafetyExpiryMs(startsAtMs: number): number {
  return startsAtMs + (LIVE_MAX_DURATION_MIN + ROOM_SAFETY_BUFFER_MIN) * 60_000;
}

export function tokenExpiryMs(sessionEndsAtMs: number): number {
  return sessionEndsAtMs + TOKEN_GRACE_MIN * 60_000;
}
