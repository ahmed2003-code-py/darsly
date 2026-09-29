import { PrismaService } from '../../prisma/prisma.service';

/**
 * Whose microphone a transcript piece is — decided by the class's own
 * records, never by the audio: no voice recognition, no biometrics, no model
 * guessing. The teacher's page records each microphone separately and says
 * whose it is; the server believes it only when its own track table agrees
 * (that person published an AUDIO track in this run, open while the piece was
 * recorded). Otherwise the piece is UNKNOWN — never someone else's name.
 *
 * It names the owner of the microphone, not the owner of the voice: two
 * students at one device are one speaker, and the UI says so.
 */
export type SpeakerKind = 'TEACHER' | 'STAFF' | 'STUDENT' | 'GUEST' | 'UNKNOWN';

export interface VerifiedSpeaker {
  speakerUserId: string | null;
  speakerKind: SpeakerKind | null;
  speakerName: string | null;
}

/** Grace around a track's open interval: the page's clock and the server's are not the same clock. */
const SLACK_MS = 5_000;

export async function verifySpeaker(
  prisma: PrismaService,
  input: {
    sessionId: string;
    run: string;
    teacherUserId: string | null;
    uploaderUserId: string;
    claimedUserId: string | null | undefined;
    startMs: number;
    durationMs: number | null;
  },
): Promise<VerifiedSpeaker> {
  const claimed = input.claimedUserId?.trim();
  // A mixed piece (the old capture, or its fallback): no attribution at all.
  if (!claimed) return { speakerUserId: null, speakerKind: null, speakerName: null };
  const unknown: VerifiedSpeaker = { speakerUserId: null, speakerKind: 'UNKNOWN', speakerName: null };

  // The uploader's own microphone: the teacher side's page records it itself.
  if (claimed === input.uploaderUserId) {
    const me = await prisma.user.findUnique({ where: { id: claimed }, select: { fullName: true } });
    if (!me) return unknown;
    return {
      speakerUserId: claimed,
      speakerKind: claimed === input.teacherUserId ? 'TEACHER' : 'STAFF',
      speakerName: me.fullName,
    };
  }

  // Anyone else: they must have published a microphone in this run, open
  // while this piece was being recorded.
  const start = new Date(input.startMs - SLACK_MS);
  const end = new Date(input.startMs + (input.durationMs ?? 0) + SLACK_MS);
  const track = await prisma.liveRtcTrack.findFirst({
    where: {
      sessionId: input.sessionId,
      roomName: input.run,
      userId: claimed,
      kind: 'AUDIO',
      createdAt: { lte: end },
      OR: [{ closedAt: null }, { closedAt: { gte: start } }],
    },
    select: { connection: { select: { role: true } } },
  });
  if (!track) return unknown;
  const user = await prisma.user.findUnique({
    where: { id: claimed },
    select: { fullName: true, role: true, guestBuyer: { select: { displayName: true } } },
  });
  if (!user) return unknown;
  if (track.connection.role === 'TEACHER') {
    return { speakerUserId: claimed, speakerKind: claimed === input.teacherUserId ? 'TEACHER' : 'STAFF', speakerName: user.fullName };
  }
  if (user.guestBuyer) return { speakerUserId: claimed, speakerKind: 'GUEST', speakerName: user.guestBuyer.displayName };
  return { speakerUserId: claimed, speakerKind: 'STUDENT', speakerName: user.fullName };
}

/** Distinct known voices in a transcript as one reader sees it (0: no speakers recorded). */
export function countSpeakers(segments: { speaker?: ShownSpeaker }[]): number {
  const keys = new Set<string>();
  for (const { speaker: s } of segments) {
    if (!s || s.kind === 'UNKNOWN') continue;
    keys.add(s.self ? 'self' : s.ordinal ? `n${s.ordinal}` : `${s.kind}:${s.name ?? ''}`);
  }
  return keys.size;
}

/** A speaker as stored in the class's transcript segments. */
export interface StoredSpeaker {
  kind: SpeakerKind;
  userId?: string | null;
  name?: string | null;
}

/** A speaker as a reader receives it: never a user id. */
export interface ShownSpeaker {
  kind: SpeakerKind;
  /** The teacher side's names; a student's own name for the teacher only. */
  name?: string | null;
  /** This reader's own microphone ("أنت"). */
  self?: boolean;
  /** Other students, for a student or a course viewer: "طالب 1", "طالب 2"… */
  ordinal?: number;
}

/**
 * The segments as one reader may see them. Nobody receives a user id. The
 * teacher side sees every name. A student sees the teacher's name, "you" for
 * their own microphone, and every other student as a number (in order of
 * first speaking) — a classmate's full name is not theirs to keep, least of
 * all in a replay someone else bought later.
 */
export function segmentsFor<T extends { speaker?: StoredSpeaker | null }>(
  segments: T[],
  viewer: { teacher: boolean; userId: string | null },
): (Omit<T, 'speaker'> & { speaker?: ShownSpeaker })[] {
  const ordinals = new Map<string, number>();
  return segments.map((seg) => {
    const { speaker, ...rest } = seg;
    if (!speaker) return rest;
    let shown: ShownSpeaker;
    if (speaker.kind === 'UNKNOWN') shown = { kind: 'UNKNOWN' };
    else if (viewer.teacher || speaker.kind === 'TEACHER' || speaker.kind === 'STAFF')
      shown = { kind: speaker.kind, name: speaker.name ?? null };
    else if (viewer.userId && speaker.userId === viewer.userId) shown = { kind: speaker.kind, self: true };
    else {
      const key = speaker.userId ?? `?${speaker.name}`;
      if (!ordinals.has(key)) ordinals.set(key, ordinals.size + 1);
      shown = { kind: 'STUDENT', ordinal: ordinals.get(key) };
    }
    return { ...rest, speaker: shown };
  });
}
