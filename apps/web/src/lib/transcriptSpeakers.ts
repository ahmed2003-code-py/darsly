/**
 * A transcript with speakers, as a reader sees it. The server never sends a
 * user id: a speaker is a kind, and a name (the teacher side), "you" (the
 * reader's own microphone), or a number (another student, for a student).
 * A transcript without speakers (mixed capture, every older class) has none
 * of this and is shown exactly as before.
 */
export type ShownSpeaker = {
  kind: 'TEACHER' | 'STAFF' | 'STUDENT' | 'GUEST' | 'UNKNOWN';
  name?: string | null;
  self?: boolean;
  ordinal?: number;
};

export type SpeakerSegment = {
  startSec: number | null;
  durationSec: number | null;
  text: string;
  speaker?: ShownSpeaker;
  overlap?: boolean;
};

export type SpeakerGroup<S extends SpeakerSegment> = {
  speaker: ShownSpeaker | undefined;
  startSec: number | null;
  overlap: boolean;
  segments: S[];
};

const keyOf = (s: ShownSpeaker | undefined) =>
  !s ? '' : s.self ? 'self' : s.ordinal ? `n${s.ordinal}` : `${s.kind}:${s.name ?? ''}`;

export const hasSpeakers = (segments: SpeakerSegment[]) => segments.some((s) => !!s.speaker);

/** Consecutive words of one microphone read as one turn. */
export function groupBySpeaker<S extends SpeakerSegment>(segments: S[]): SpeakerGroup<S>[] {
  const out: SpeakerGroup<S>[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    // Words said over someone else start their own turn, marked as such.
    if (last && keyOf(last.speaker) === keyOf(seg.speaker) && !seg.overlap && !last.overlap) {
      last.segments.push(seg);
      continue;
    }
    out.push({
      speaker: seg.speaker,
      startSec: seg.startSec,
      overlap: !!seg.overlap,
      segments: [seg],
    });
  }
  return out;
}

/** The label a reader sees; `t` is i18next's. */
export function speakerLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  s: ShownSpeaker | undefined,
) {
  if (!s || s.kind === 'UNKNOWN') return t('record.transcript.speaker.unknown');
  if (s.self) return t('record.transcript.speaker.you');
  if (s.ordinal) return t('record.transcript.speaker.student', { n: s.ordinal });
  if (s.name) return s.name;
  return s.kind === 'TEACHER'
    ? t('record.transcript.speaker.teacher')
    : s.kind === 'GUEST'
      ? t('record.transcript.speaker.guest')
      : t('record.transcript.speaker.unknown');
}
