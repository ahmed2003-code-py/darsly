/**
 * Every piece of the lesson's audio, delivered — or accounted for.
 *
 * Before this, a piece whose upload failed three times (about 23 seconds of
 * bad connection) was deleted from the browser as if it had been sent, so a
 * short network drop made a permanent hole in the transcript and nothing on
 * either side knew it was there. Now:
 *
 *  - a finished piece with voice in it is OWED: it stays in the browser's
 *    store until the server takes it, or refuses it for good (a 4xx that is
 *    not a timeout or a rate limit);
 *  - an owed piece is tried again when the connection comes back, every
 *    little while, and whenever the class's page opens again (a reload, a
 *    crash, the next day) — the server takes a late piece if it was spoken
 *    while capture was on;
 *  - every piece is reported to the server's manifest — QUEUED when made,
 *    SILENT when there was nothing to send, DROPPED when refused — so the
 *    transcript can be called complete only when it is;
 *  - the page keeps count: made, delivered, owed, dropped, silent.
 */
import type { PieceMeta, PieceStore } from './lessonAudioStore';

export type Delivery =
  | { kind: 'sent' }
  /** Refused for good: asking again will not help (capture off, not this class's run, another tab). */
  | { kind: 'refused'; status: number; code: string | null }
  /** Not answered (offline, a server error, a rate limit): still owed. */
  | { kind: 'failed' };

/** One attempt and its quick retries; `failed` means "owed, try later", never "gone". */
export async function deliverWithRetry(
  upload: () => Promise<void>,
  waits: number[] = [2_000, 6_000, 15_000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Delivery> {
  for (let i = 0; ; i++) {
    try {
      await upload();
      return { kind: 'sent' };
    } catch (e) {
      const res = (e as { response?: { status?: number; data?: { code?: string } } })?.response;
      const status = res?.status;
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return { kind: 'refused', status, code: res?.data?.code ?? null };
      }
      if (i >= waits.length) return { kind: 'failed' };
      await sleep(waits[i]);
    }
  }
}

export interface PieceReport {
  seq: number;
  durationMs: number;
  state: 'QUEUED' | 'SILENT' | 'DROPPED';
  reason?: string;
  leaseId?: string;
}

/** What the capture tells about each piece it made. */
export interface PieceSink {
  /** The lease pieces are made under now (stored with each piece). */
  leaseId(): string | undefined;
  /** A piece with voice in it is finished: owed until delivered or refused. */
  owe(p: {
    id: string;
    seq: number;
    blob: Blob;
    durationMs: number;
    speaker?: string;
    leaseId?: string;
  }): Promise<void>;
  /** A stretch with nothing to send (silence, a muted microphone): covered, nothing uploaded. */
  silent(p: { id?: string; seq: number; durationMs: number; reason?: string }): void;
  /** Whether the page's audio really runs. */
  health(ok: boolean, problem?: string): void;
}

export interface OutboxStats {
  created: number;
  uploaded: number;
  pending: number;
  dropped: number;
  silent: number;
}

export type UploadOwed = (
  seq: number,
  blob: Blob,
  durationMs: number,
  speaker: string | undefined,
  leaseId: string | undefined,
) => Promise<void>;

/** The recorder hands over a chunk this often (lessonAudio.ts) — a leftover's length is at least this. */
const CHUNK_MS = 5_000;
const MIN_PIECE_BYTES = 2_000;

export class PieceOutbox implements PieceSink {
  readonly stats: OutboxStats = { created: 0, uploaded: 0, pending: 0, dropped: 0, silent: 0 };
  audioOk = true;
  audioProblem: string | null = null;
  private reports: PieceReport[] = [];
  private inFlight = new Set<string>();
  /** Owed pieces when the browser has no store (private window): kept for this page's life. */
  private memory = new Map<string, { meta: PieceMeta; blob: Blob }>();
  private owed = new Set<string>();
  private lease: string | undefined;
  private flushing: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly o: {
      session: string;
      store: PieceStore | null;
      upload: UploadOwed;
      waits?: number[];
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  setLease(id: string | undefined) {
    this.lease = id;
  }

  leaseId() {
    return this.lease;
  }

  /** Told whenever a count changes (the page shows them). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.stats.pending = this.owed.size;
    for (const fn of this.listeners) fn();
  }

  /** Reports not yet given to the server; the caller hands them back on failure. */
  drainReports(): PieceReport[] {
    const out = this.reports;
    this.reports = [];
    return out;
  }

  requeueReports(r: PieceReport[]) {
    this.reports = [...r, ...this.reports];
  }

  health(ok: boolean, problem?: string) {
    if (this.audioOk === ok && (this.audioProblem ?? undefined) === problem) return;
    this.audioOk = ok;
    this.audioProblem = ok ? null : (problem ?? 'AUDIO_NOT_RUNNING');
    this.changed();
  }

  silent(p: { id?: string; seq: number; durationMs: number; reason?: string }) {
    this.stats.silent++;
    this.reports.push({
      seq: p.seq,
      durationMs: Math.max(0, Math.round(p.durationMs)),
      state: 'SILENT',
      ...(p.reason ? { reason: p.reason } : {}),
      leaseId: this.lease,
    });
    this.changed();
  }

  async owe(p: {
    id: string;
    seq: number;
    blob: Blob;
    durationMs: number;
    speaker?: string;
    leaseId?: string;
  }) {
    const leaseId = p.leaseId ?? this.lease;
    this.stats.created++;
    this.reports.push({
      seq: p.seq,
      durationMs: Math.round(p.durationMs),
      state: 'QUEUED',
      leaseId,
    });
    this.owed.add(p.id);
    const meta = {
      id: p.id,
      session: this.o.session,
      seq: p.seq,
      mime: p.blob.type,
      startedAt: Date.now() - p.durationMs,
      lastAt: Date.now(),
      voiced: true,
      speaker: p.speaker,
      leaseId,
      finished: true,
      durationMs: Math.round(p.durationMs),
    } satisfies PieceMeta;
    // Kept as owed before the first try: a page that closes mid-upload still has it.
    if (this.o.store)
      await this.o.store.mark(p.id, { finished: true, durationMs: meta.durationMs, leaseId });
    else this.memory.set(p.id, { meta, blob: p.blob });
    this.changed();
    await this.send(meta, p.blob);
  }

  /** Deliver one owed piece; on success or a final refusal it is no longer owed. */
  private async send(meta: PieceMeta, blob: Blob): Promise<Delivery | null> {
    if (this.inFlight.has(meta.id)) return null;
    this.inFlight.add(meta.id);
    try {
      const r = await deliverWithRetry(
        () => this.o.upload(meta.seq, blob, meta.durationMs ?? 0, meta.speaker, meta.leaseId),
        this.o.waits,
        this.o.sleep,
      );
      if (r.kind === 'sent') {
        this.stats.uploaded++;
        this.forget(meta.id);
      } else if (r.kind === 'refused') {
        this.stats.dropped++;
        this.reports.push({
          seq: meta.seq,
          durationMs: meta.durationMs ?? 0,
          state: 'DROPPED',
          reason: r.code ?? `HTTP_${r.status}`,
          leaseId: meta.leaseId,
        });
        this.forget(meta.id);
      }
      this.changed();
      return r;
    } finally {
      this.inFlight.delete(meta.id);
    }
  }

  private forget(id: string) {
    this.owed.delete(id);
    this.memory.delete(id);
    void this.o.store?.remove(id);
  }

  /**
   * Deliver everything still owed for this class: finished pieces whose
   * upload failed, and pieces interrupted by a reload or a crash (their
   * chunks joined). Pieces being recorded right now are left alone. One flush
   * at a time; a second call waits for it.
   */
  flush(recordingNow: string[] = []): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        const left = [
          ...(this.o.store ? await this.o.store.leftovers(this.o.session, recordingNow) : []),
          ...[...this.memory.values()].filter((x) => !recordingNow.includes(x.meta.id)),
        ];
        const seen = new Set<string>();
        for (const { meta, blob } of left) {
          if (seen.has(meta.id) || this.inFlight.has(meta.id)) continue;
          seen.add(meta.id);
          const durationMs =
            meta.durationMs ?? Math.max(0, meta.lastAt - meta.startedAt) + CHUNK_MS;
          if (!meta.voiced || blob.size < MIN_PIECE_BYTES) {
            // An interrupted piece that never heard a voice: nothing to send.
            if (!meta.finished) this.silent({ seq: meta.seq, durationMs, reason: 'INTERRUPTED' });
            this.forget(meta.id);
            continue;
          }
          if (!this.owed.has(meta.id)) {
            // Found after a reload: say it exists before trying to deliver it.
            this.owed.add(meta.id);
            this.reports.push({
              seq: meta.seq,
              durationMs,
              state: 'QUEUED',
              leaseId: meta.leaseId,
            });
          }
          const r = await this.send({ ...meta, durationMs }, blob);
          // Still unreachable: the rest will not do better right now.
          if (r?.kind === 'failed') break;
        }
      } finally {
        this.changed();
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}
