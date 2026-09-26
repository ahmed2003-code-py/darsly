/**
 * The lesson's audio, for its transcript — captured in the teacher's page.
 *
 * Cloudflare carries media only; nothing transcribes the class on the way
 * through. The teacher's page already hears everything worth transcribing:
 * their own microphone, and every student they let speak. It mixes those
 * into one low-bitrate voice stream and uploads it in self-contained pieces
 * (each its own file, with its own header), so a piece lost to a bad moment
 * costs three minutes of words, not the lesson.
 *
 * Nothing leaves the page when nobody spoke: a piece with no voice in it is
 * not uploaded (and not paid for). Only when the server says so
 * (`access.transcribe`), and only for the teacher.
 *
 * The piece being recorded is kept in the browser as it grows (a chunk every
 * few seconds, lessonAudioStore.ts), so a reload or a crash does not lose it:
 * the page uploads what is left of it when it comes back (`recover`).
 */
import type { PieceStore } from './lessonAudioStore';

/** How long one piece runs. */
export const PIECE_MS = 3 * 60_000;
/** Below this (RMS, 0..1) a piece is silence. */
const VOICE_LEVEL = 0.012;
const LEVEL_EVERY_MS = 400;
/** A piece smaller than this holds no speech worth sending. */
const MIN_PIECE_BYTES = 2_000;
/** The recorder hands over (and the store keeps) a chunk this often. */
const CHUNK_MS = 5_000;

export type UploadPiece = (seq: number, blob: Blob, durationMs?: number) => Promise<void>;

/**
 * The last piece number handed out on this page. A piece is numbered by the
 * second it started; capture switched off and on within one second would
 * otherwise start two pieces with the same number (and the second would be
 * taken for a retry of the first).
 */
let lastSeq = 0;
export function nextSeq(nowMs = Date.now()): number {
  lastSeq = Math.max(Math.floor(nowMs / 1000), lastSeq + 1);
  return lastSeq;
}

/** The recorder format this browser can make: WebM/Opus, or MP4 (Safari). */
export function pickAudioMime(
  isSupported: (t: string) => boolean = (t) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
): string | null {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (isSupported(t)) return t;
  }
  return null;
}

/** Uploads one piece, trying again on a network hiccup. */
export async function uploadWithRetry(
  upload: UploadPiece,
  seq: number,
  blob: Blob,
  waits: number[] = [2_000, 6_000, 15_000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await upload(seq, blob);
      return true;
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      // Refused (switched off, class over, not theirs): asking again will not help.
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
      if (i >= waits.length) return false;
      await sleep(waits[i]);
    }
  }
}

export class LessonAudio {
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sources = new Map<MediaStreamTrack, MediaStreamAudioSourceNode>();
  private rec: { rec: MediaRecorder; done: Promise<void> } | null = null;
  private rotate: ReturnType<typeof setInterval> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly mime: string | null;

  private currentId: string | null = null;

  constructor(
    private readonly upload: UploadPiece,
    private readonly pieceMs = PIECE_MS,
    /** Where the piece being recorded is kept until it is uploaded (null: memory only). */
    private readonly store: PieceStore | null = null,
    /** The class, so leftovers go to the right one. */
    private readonly session = '',
  ) {
    this.mime = pickAudioMime();
  }

  /**
   * Upload what an earlier page of this class left behind (a reload, a
   * crash): pieces recorded but never sent. Silent ones are just dropped.
   */
  async recover(): Promise<number> {
    if (!this.store) return 0;
    const left = await this.store.leftovers(this.session, this.currentId ? [this.currentId] : []);
    let sent = 0;
    for (const { meta, blob } of left) {
      if (meta.voiced && blob.size >= MIN_PIECE_BYTES) {
        const ms = Math.max(0, meta.lastAt - meta.startedAt) + CHUNK_MS;
        if (await uploadWithRetry((s, b) => this.upload(s, b, ms), meta.seq, blob)) sent++;
      }
      await this.store.remove(meta.id);
    }
    return sent;
  }

  /** False when this browser cannot record audio at all. */
  start(): boolean {
    if (!this.mime || typeof AudioContext === 'undefined') return false;
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    // The mix feeds the recorder and the level meter; nothing is played back.
    this.analyser.connect(this.dest);
    void this.ctx.resume().catch(() => undefined);
    this.startPiece();
    this.rotate = setInterval(() => this.nextPiece(), this.pieceMs);
    return true;
  }

  /** What to hear now: the teacher's microphone and the voices pulled in. */
  setTracks(tracks: MediaStreamTrack[]) {
    if (!this.ctx || !this.analyser || this.stopped) return;
    const want = new Set(tracks.filter((t) => t.kind === 'audio' && t.readyState === 'live'));
    for (const [t, node] of this.sources) {
      if (!want.has(t) || t.readyState !== 'live') {
        node.disconnect();
        this.sources.delete(t);
      }
    }
    for (const t of want) {
      if (this.sources.has(t)) continue;
      const node = this.ctx.createMediaStreamSource(new MediaStream([t]));
      node.connect(this.analyser);
      this.sources.set(t, node);
    }
    // Chrome suspends a context started without a gesture; a later call may succeed.
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** The class is over (or the teacher left): the last piece is sent, then everything stops. */
  async stop(maxWaitMs = 15_000) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rotate) clearInterval(this.rotate);
    const last = this.finishPiece();
    await Promise.race([
      // The recorder hands over its last data asynchronously; only then is
      // the final piece's upload under way to be waited for.
      last.then(() => Promise.allSettled([...this.pending])),
      new Promise((r) => setTimeout(r, maxWaitMs)),
    ]);
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();
    if (this.meter) clearInterval(this.meter);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  // ── Pieces ────────────────────────────────────────────────────────────────

  private nextPiece() {
    void this.finishPiece();
    if (!this.stopped) this.startPiece();
  }

  private startPiece() {
    if (!this.dest || !this.mime) return;
    const rec = new MediaRecorder(this.dest.stream, {
      mimeType: this.mime,
      audioBitsPerSecond: 32_000,
    });
    const seq = nextSeq();
    const startedAt = Date.now();
    const chunks: Blob[] = [];
    let voiced = false;
    const id = `${this.session}:${seq}`;
    this.currentId = id;
    const store = this.store;
    void store?.begin({
      id,
      session: this.session,
      seq,
      mime: this.mime,
      startedAt,
      lastAt: startedAt,
      voiced: false,
    });
    if (this.meter) clearInterval(this.meter);
    const buf = new Float32Array(this.analyser!.fftSize);
    this.meter = setInterval(() => {
      if (voiced || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      if (Math.sqrt(sum / buf.length) > VOICE_LEVEL) voiced = true;
    }, LEVEL_EVERY_MS);
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      // Kept as it arrives: this is what survives a reload.
      void store?.append(id, e.data, Date.now(), voiced);
    };
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: this.mime ?? 'audio/webm' });
        if (voiced && blob.size >= MIN_PIECE_BYTES) {
          const ms = Date.now() - startedAt;
          const p = uploadWithRetry((s, b) => this.upload(s, b, ms), seq, blob)
            // Sent, or refused for good: either way it is no longer owed.
            .then(() => store?.remove(id))
            .finally(() => this.pending.delete(p));
          this.pending.add(p);
        } else {
          void store?.remove(id);
        }
        resolve();
      };
    });
    rec.start(CHUNK_MS);
    this.rec = { rec, done };
  }

  /** Ends the current piece; resolves once its upload (if any) has begun. */
  private finishPiece(): Promise<void> {
    const cur = this.rec;
    this.rec = null;
    if (!cur) return Promise.resolve();
    if (cur.rec.state === 'inactive') return Promise.resolve();
    try {
      cur.rec.stop();
    } catch {
      return Promise.resolve();
    }
    return cur.done;
  }
}
