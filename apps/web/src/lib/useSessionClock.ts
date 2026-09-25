import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The classroom clock, anchored to the server.
 *
 * The server owns every time that matters — when the class actually started,
 * when it now ends (an extension moves that), and what time it is. The page
 * only animates between what it was last told: each timing it receives carries
 * `serverNow`, and the difference from the device's own clock at that moment
 * is kept as an offset, so a phone whose clock is two minutes off still counts
 * down to the right second.
 *
 * Fed from three places, all carrying the same absolute timestamps: the join
 * response (a refresh starts right), every heartbeat reply (re-anchored every
 * 30s at no extra cost), and the `live:timing-updated` socket event (an
 * extension shows up at once). A reply older than the one already applied is
 * ignored, so a slow heartbeat cannot undo an extension that overtook it.
 *
 * Session elapsed and remaining only. How long the class has been *recorded*
 * is a different clock, and it waits for the provider to confirm recording.
 */
export interface SessionTiming {
  startedAt: string | Date | null;
  endsAt: string | Date;
  serverNow: string | Date;
}

/** A timestamp as epoch-ms, or null for anything that is not one (never NaN). */
const ms = (v: string | Date | null | undefined) => {
  if (v == null || v === '') return null;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
};

export interface ClockAnchor {
  startedAt: number | null;
  endsAt: number;
  serverNow: number;
  /** serverNow − the device clock at the moment it arrived. */
  offset: number;
}

/**
 * The anchor after receiving `t` on a device whose clock reads `deviceNow`.
 * An answer the server produced before the one already applied is ignored.
 */
export function nextAnchor(
  current: ClockAnchor | null,
  t: SessionTiming | null | undefined,
  deviceNow: number,
): ClockAnchor | null {
  if (!t) return current;
  const serverNow = ms(t.serverNow);
  const endsAt = ms(t.endsAt);
  if (serverNow == null || endsAt == null) return current;
  if (current && serverNow < current.serverNow) return current;
  return { startedAt: ms(t.startedAt), endsAt, serverNow, offset: serverNow - deviceNow };
}

/** Elapsed and remaining, in the server's time, at device time `deviceNow`. */
export function readClock(a: ClockAnchor, deviceNow: number) {
  const now = deviceNow + a.offset;
  return {
    endsAt: a.endsAt,
    elapsedMs: a.startedAt != null ? Math.max(0, now - a.startedAt) : null,
    remainingMs: a.endsAt - now,
  };
}

export function useSessionClock() {
  const anchor = useRef<ClockAnchor | null>(null);
  const [, setTick] = useState(0);

  const apply = useCallback((t: SessionTiming | null | undefined) => {
    const next = nextAnchor(anchor.current, t, Date.now());
    if (next === anchor.current) return;
    anchor.current = next;
    setTick((n) => n + 1);
  }, []);

  // A local re-render once a second; no network.
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  const a = anchor.current;
  if (!a) return { ready: false as const, apply };
  return { ready: true as const, apply, ...readClock(a, Date.now()) };
}

/** 1:05:09 / 05:09 */
export function formatClock(msValue: number): string {
  const total = Math.max(0, Math.floor(msValue / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
