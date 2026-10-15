/**
 * Where the time goes when a camera or a microphone is switched — measured,
 * not guessed.
 *
 * Each toggle is one "op" with marks along the way:
 *
 *   click → deviceReady (getUserMedia answered) → localPreview (self-view on
 *   screen) → publishRequest (offer sent) → sfuConfirmed (answer applied)
 *
 * and a viewer's page marks `remoteVisible` when the track arrives. Marks go
 * to the Performance timeline (visible in DevTools), to a small in-page ring
 * (`window.__darslyLiveTimings`, read by the browser E2E), and to the console
 * when `localStorage['darsly-live-debug']` is set. Nothing leaves the page.
 */
export type LiveMark =
  | 'click'
  | 'deviceReady'
  | 'localPreview'
  | 'publishRequest'
  | 'sfuConfirmed'
  | 'unpublished'
  | 'failed'
  | 'remoteVisible';

export interface LiveTiming {
  op: string;
  kind: string;
  mark: LiveMark;
  at: number;
  /** Milliseconds since this op's click. */
  sinceClick: number | null;
}

const RING = 200;
const clicks = new Map<string, number>();
let seq = 0;

function ring(): LiveTiming[] {
  const w = globalThis as unknown as { __darslyLiveTimings?: LiveTiming[] };
  return (w.__darslyLiveTimings ??= []);
}

function debug(): boolean {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem('darsly-live-debug');
  } catch {
    return false;
  }
}

/** A new op (one press); returns its id for the marks that follow. */
export function beginOp(kind: string): string {
  const op = `${kind}-${++seq}`;
  const at = typeof performance !== 'undefined' ? performance.now() : Date.now();
  clicks.set(op, at);
  push(op, kind, 'click', at);
  return op;
}

export function markOp(op: string, kind: string, mark: LiveMark): void {
  const at = typeof performance !== 'undefined' ? performance.now() : Date.now();
  push(op, kind, mark, at);
  if (mark === 'sfuConfirmed' || mark === 'unpublished' || mark === 'failed') clicks.delete(op);
}

function push(op: string, kind: string, mark: LiveMark, at: number) {
  const start = clicks.get(op);
  const t: LiveTiming = {
    op,
    kind,
    mark,
    at: Date.now(),
    sinceClick: start != null ? Math.round(at - start) : null,
  };
  const r = ring();
  r.push(t);
  if (r.length > RING) r.splice(0, r.length - RING);
  try {
    performance?.mark?.(`darsly:${kind}:${mark}`, { detail: t });
  } catch {
    /* older browsers: the ring is enough */
  }
  if (debug()) console.debug('[live-timing]', kind, mark, t.sinceClick ?? '', op);
}
