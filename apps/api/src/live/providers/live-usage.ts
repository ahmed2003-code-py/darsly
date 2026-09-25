/**
 * What a Cloudflare class used — captured once its teardown is done, for cost
 * tracking. Not a ledger and not a bill: Cloudflare bills SFU egress per GB
 * across the account, and does not report it per session. So this records
 * what Darsly knows exactly (who was connected, for how long, what was
 * recorded) and an egress *estimate* from those minutes, labelled as such
 * with its basis, so the two can be reconciled against the invoice later.
 */

/**
 * Measured on the real SFU in Checkpoint B.6 (teacher camera 720p simulcast +
 * voice, education mode): ~786 kbps per receiving student ≈ 0.354 GB/hour.
 * An estimate for a class with a screen share or several speakers is higher;
 * a student stepped down to the small layer is lower.
 */
export const EST_GB_PER_RECEIVER_HOUR = 0.354;
/** Cloudflare's published Realtime price after the free tier (1,000 GB/month). */
export const PRICE_USD_PER_GB = 0.05;

export interface UsageConnection {
  role: 'TEACHER' | 'STUDENT' | 'RECORDER';
  purpose: 'RECEIVE' | 'SEND';
  createdAt: Date;
  closedAt: Date | null;
}

export interface LiveUsage {
  provider: 'CLOUDFLARE';
  capturedAt: string;
  connections: number;
  receiveMinutes: { teacher: number; student: number; recorder: number };
  sendMinutes: { teacher: number; student: number };
  peakReceivers: number;
  recordedMinutes: number;
  estimate: {
    egressGb: number;
    usdAfterFreeTier: number;
    basis: string;
  };
}

const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

export function usageOf(
  conns: UsageConnection[],
  opts: { endedAt: Date; recordedSec: number; now?: Date },
): LiveUsage {
  const end = opts.endedAt.getTime();
  const span = (c: UsageConnection) =>
    Math.max(0, Math.min(c.closedAt?.getTime() ?? end, end) - c.createdAt.getTime());
  const sum = (f: (c: UsageConnection) => boolean) =>
    minutes(conns.filter(f).reduce((n, c) => n + span(c), 0));
  // Peak concurrent receivers: a sweep over open/close instants.
  const events: [number, number][] = [];
  for (const c of conns.filter((x) => x.purpose === 'RECEIVE')) {
    const a = c.createdAt.getTime();
    const b = Math.min(c.closedAt?.getTime() ?? end, end);
    if (b > a) events.push([a, 1], [b, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  const receiveMinutes = {
    teacher: sum((c) => c.purpose === 'RECEIVE' && c.role === 'TEACHER'),
    student: sum((c) => c.purpose === 'RECEIVE' && c.role === 'STUDENT'),
    recorder: sum((c) => c.purpose === 'RECEIVE' && c.role === 'RECORDER'),
  };
  const receiverHours =
    (receiveMinutes.teacher + receiveMinutes.student + receiveMinutes.recorder) / 60;
  const egressGb = Math.round(receiverHours * EST_GB_PER_RECEIVER_HOUR * 1000) / 1000;
  return {
    provider: 'CLOUDFLARE',
    capturedAt: (opts.now ?? new Date()).toISOString(),
    connections: conns.length,
    receiveMinutes,
    sendMinutes: {
      teacher: sum((c) => c.purpose === 'SEND' && c.role === 'TEACHER'),
      student: sum((c) => c.purpose === 'SEND' && c.role === 'STUDENT'),
    },
    peakReceivers: peak,
    recordedMinutes: minutes(opts.recordedSec * 1000),
    estimate: {
      egressGb,
      usdAfterFreeTier: Math.round(egressGb * PRICE_USD_PER_GB * 10_000) / 10_000,
      basis: `ESTIMATED: receive-minutes x ${EST_GB_PER_RECEIVER_HOUR} GB/h (measured B.6, 720p education mode); $${PRICE_USD_PER_GB}/GB (official, after 1,000 GB/month free)`,
    },
  };
}
