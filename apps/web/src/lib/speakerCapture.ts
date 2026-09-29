/**
 * The lesson's audio, one microphone at a time — so the transcript can say
 * who said what.
 *
 * The teacher's page already receives every microphone separately (its own,
 * and each student it lets speak). Instead of mixing them into one stream
 * (lessonAudio.ts), it records each one on its own and tells the server whose
 * it is. The server believes that only when its own track table agrees
 * (api: transcription/speakers.ts) — this is microphone ownership, not voice
 * recognition: nothing here listens to who is speaking.
 *
 * Cost stays close to the mixed capture: silence is never uploaded, a
 * student's turn is one piece (not one per sentence), and a piece shorter
 * than a few seconds of voice is never cut off on its own (no two-second
 * calls). When the browser cannot record this way — or more microphones are
 * open than it should record separately — the rest falls back to the mixed
 * capture, unattributed, as before.
 */
import { LessonAudio, nextSeq, pickAudioMime, uploadWithRetry } from './lessonAudio';
import type { PieceStore } from './lessonAudioStore';

/** Upload one piece, saying whose microphone it is. */
export type UploadSpeakerPiece = (
  seq: number,
  blob: Blob,
  durationMs: number | undefined,
  speakerUserId: string | undefined,
) => Promise<void>;

export const TEACHER_MAX_MS = 180_000;
/** The teacher's piece is cut when someone else starts talking — once it holds this much. */
export const TEACHER_MIN_BEFORE_TURN_MS = 20_000;
export const STUDENT_MAX_MS = 60_000;
/** A student's turn ends after this much voice followed by this much silence. */
export const TURN_MIN_VOICE_MS = 3_000;
export const TURN_SILENCE_MS = 8_000;
/** A piece that never heard a voice is restarted this often, so a turn's start time stays true. */
export const IDLE_RESTART_MS = 30_000;
/** More open microphones than this are mixed together (unattributed) instead. */
export const MAX_SEPARATE = 6;

const VOICE_LEVEL = 0.012;
const LEVEL_EVERY_MS = 400;
const MIN_PIECE_BYTES = 2_000;
const CHUNK_MS = 5_000;

export interface PieceClock {
  /** The uploader's own microphone (the teacher side). */
  own: boolean;
  startedAt: number;
  /** Total time voice was heard in this piece. */
  voicedMs: number;
  lastVoiceAt: number | null;
}

export type CutDecision = 'keep' | 'cut' | 'restart';

/**
 * When to end a piece — the whole rule, in one pure function.
 *  - 'cut': finish it (uploaded if it held voice) and start the next.
 *  - 'restart': it held no voice yet; drop it and start fresh (nothing sent).
 */
export function planCut(p: PieceClock, now: number, othersTalking: boolean): CutDecision {
  const age = now - p.startedAt;
  if (p.voicedMs === 0) return age >= IDLE_RESTART_MS ? 'restart' : 'keep';
  if (p.own) {
    if (age >= TEACHER_MAX_MS) return 'cut';
    // A student starts answering: the teacher's words so far go before theirs.
    if (othersTalking && age >= TEACHER_MIN_BEFORE_TURN_MS) return 'cut';
    return 'keep';
  }
  if (age >= STUDENT_MAX_MS) return 'cut';
  if (
    p.voicedMs >= TURN_MIN_VOICE_MS &&
    p.lastVoiceAt != null &&
    now - p.lastVoiceAt >= TURN_SILENCE_MS
  )
    return 'cut';
  return 'keep';
}

/** Which microphones get their own recorder: the uploader's first, then in arrival order. */
export function planSources(
  mics: { userId: string; own: boolean }[],
  current: string[],
  max = MAX_SEPARATE,
): { separate: string[]; mixed: string[] } {
  const ordered = [
    ...mics.filter((m) => m.own),
    ...mics.filter((m) => !m.own && current.includes(m.userId)),
    ...mics.filter((m) => !m.own && !current.includes(m.userId)),
  ];
  const separate = ordered.slice(0, max).map((m) => m.userId);
  return { separate, mixed: ordered.slice(max).map((m) => m.userId) };
}

interface Source {
  userId: string;
  own: boolean;
  track: MediaStreamTrack;
  ctx: AudioContext;
  node: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  dest: MediaStreamAudioDestinationNode;
  piece: Piece | null;
  talking: boolean;
}

interface Piece {
  rec: MediaRecorder;
  clock: PieceClock;
  seq: number;
  id: string;
  voiced: boolean;
  done: Promise<void>;
  discard: boolean;
}

export class SpeakerCapture {
  private sources = new Map<string, Source>();
  private mixed: LessonAudio | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly mime: string | null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly upload: UploadSpeakerPiece,
    /** The page's own user (the teacher side). */
    private readonly me: string,
    private readonly store: PieceStore | null = null,
    private readonly session = '',
  ) {
    this.mime = pickAudioMime();
  }

  /** False when this browser cannot record separately (the caller uses the mixed capture). */
  start(): boolean {
    if (!this.mime || typeof AudioContext === 'undefined' || typeof MediaRecorder === 'undefined')
      return false;
    this.tick = setInterval(() => this.check(), LEVEL_EVERY_MS);
    return true;
  }

  /**
   * Pieces an earlier page of this class left unsent (a reload, a crash) —
   * each still claiming its own microphone (the server checks it again).
   * Only pieces begun before this capture: never one being recorded now.
   */
  async recover(): Promise<number> {
    if (!this.store) return 0;
    const left = await this.store.leftovers(this.session, []);
    let sent = 0;
    for (const { meta, blob } of left) {
      if (meta.startedAt >= this.startedAt) continue;
      if (meta.voiced && blob.size >= MIN_PIECE_BYTES) {
        const ms = Math.max(0, meta.lastAt - meta.startedAt) + CHUNK_MS;
        if (await uploadWithRetry((q, b) => this.upload(q, b, ms, meta.speaker), meta.seq, blob))
          sent++;
      }
      await this.store.remove(meta.id);
    }
    return sent;
  }

  /** The open microphones now, each with its owner. */
  setTracks(mics: { userId: string; track: MediaStreamTrack }[]) {
    if (this.stopped) return;
    const live = mics.filter((m) => m.track.kind === 'audio' && m.track.readyState === 'live');
    const plan = planSources(
      live.map((m) => ({ userId: m.userId, own: m.userId === this.me })),
      [...this.sources.keys()],
    );
    for (const [userId, s] of this.sources) {
      const now = live.find((m) => m.userId === userId);
      // Gone, replaced (a reconnect gives a new track), or moved to the mix: its turn ends here.
      if (!now || now.track !== s.track || !plan.separate.includes(userId)) void this.drop(userId);
    }
    for (const userId of plan.separate) {
      if (this.sources.has(userId)) continue;
      const m = live.find((x) => x.userId === userId)!;
      this.add(userId, m.track);
    }
    const overflow = live.filter((m) => plan.mixed.includes(m.userId)).map((m) => m.track);
    if (overflow.length && !this.mixed) {
      const mixed = new LessonAudio(
        (s, b, ms) => this.upload(s, b, ms, undefined),
        undefined,
        this.store,
        this.session,
      );
      if (mixed.start()) this.mixed = mixed;
    }
    this.mixed?.setTracks(overflow);
  }

  async stop(maxWaitMs = 15_000) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    const last = [...this.sources.keys()].map((u) => this.drop(u));
    await Promise.race([
      Promise.all([...last, this.mixed?.stop(maxWaitMs)]).then(() =>
        Promise.allSettled([...this.pending]),
      ),
      new Promise((r) => setTimeout(r, maxWaitMs)),
    ]);
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  private add(userId: string, track: MediaStreamTrack) {
    const ctx = new AudioContext();
    const node = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const dest = ctx.createMediaStreamDestination();
    node.connect(analyser);
    analyser.connect(dest);
    void ctx.resume().catch(() => undefined);
    const s: Source = {
      userId,
      own: userId === this.me,
      track,
      ctx,
      node,
      analyser,
      dest,
      piece: null,
      talking: false,
    };
    this.sources.set(userId, s);
    s.piece = this.startPiece(s);
  }

  private drop(userId: string): Promise<void> {
    const s = this.sources.get(userId);
    if (!s) return Promise.resolve();
    this.sources.delete(userId);
    const done = this.finish(s.piece);
    return done.finally(() => {
      s.node.disconnect();
      void s.ctx.close().catch(() => undefined);
    });
  }

  /** Levels, and the cut rule for every piece. */
  private check() {
    const now = Date.now();
    const buf = new Float32Array(1024);
    for (const s of this.sources.values()) {
      if (s.ctx.state === 'suspended') void s.ctx.resume().catch(() => undefined);
      s.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      s.talking = Math.sqrt(sum / buf.length) > VOICE_LEVEL;
      const p = s.piece;
      if (p && s.talking) {
        p.clock.voicedMs += LEVEL_EVERY_MS;
        p.clock.lastVoiceAt = now;
        p.voiced = true;
      }
    }
    for (const s of this.sources.values()) {
      if (!s.piece) continue;
      const others = [...this.sources.values()].some((o) => o !== s && o.talking);
      const d = planCut(s.piece.clock, now, others);
      if (d === 'keep') continue;
      if (d === 'restart') s.piece.discard = true;
      void this.finish(s.piece);
      s.piece = this.startPiece(s);
    }
  }

  // ── Pieces ────────────────────────────────────────────────────────────────

  private startPiece(s: Source): Piece | null {
    if (!this.mime || this.stopped) return null;
    const rec = new MediaRecorder(s.dest.stream, {
      mimeType: this.mime,
      audioBitsPerSecond: 32_000,
    });
    const seq = nextSeq();
    const startedAt = Date.now();
    const id = `${this.session}:${seq}`;
    const chunks: Blob[] = [];
    const piece: Piece = {
      rec,
      seq,
      id,
      voiced: false,
      discard: false,
      clock: { own: s.own, startedAt, voicedMs: 0, lastVoiceAt: null },
      done: Promise.resolve(),
    };
    const store = this.store;
    void store?.begin({
      id,
      session: this.session,
      seq,
      mime: this.mime,
      startedAt,
      lastAt: startedAt,
      voiced: false,
      speaker: s.userId,
    });
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      void store?.append(id, e.data, Date.now(), piece.voiced);
    };
    piece.done = new Promise<void>((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: this.mime ?? 'audio/webm' });
        if (!piece.discard && piece.voiced && blob.size >= MIN_PIECE_BYTES) {
          const ms = Date.now() - startedAt;
          const p = uploadWithRetry((q, b) => this.upload(q, b, ms, s.userId), seq, blob)
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
    return piece;
  }

  private finish(piece: Piece | null): Promise<void> {
    if (!piece || piece.rec.state === 'inactive') return Promise.resolve();
    try {
      piece.rec.stop();
    } catch {
      return Promise.resolve();
    }
    return piece.done;
  }
}
