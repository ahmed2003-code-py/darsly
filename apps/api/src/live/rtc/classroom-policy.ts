import type { LiveHandState, LiveTrackKind } from '@prisma/client';
import { canSpeak } from './live-hand';

/**
 * What one person may do in the class right now — the ONE place this is
 * decided. The SEND gate, publish, subscribe, the room state and the recorder
 * all ask this function; none of them re-derives the rules.
 *
 * It combines:
 *  - the side of the class (teacher side / student) and whether this person
 *    may moderate (session teacher, or `live.manage` in the academy);
 *  - the class's microphone and camera policies;
 *  - this person's temporary controls for this run (a mic block, a camera
 *    exemption or block);
 *  - their hand (speaking permission), which the teacher grants.
 *
 * Nothing here switches a device on: "may publish" is a permission the
 * student's own click has to use.
 */

/** RAISE_HAND: students speak when the teacher approves or invites. LISTEN_ONLY: no hands; invitations only. */
export type MicPolicy = 'RAISE_HAND' | 'LISTEN_ONLY';
/**
 * SPEAKERS_ONLY (default, the historical behaviour): a student's camera only
 * while they may speak. OPTIONAL: any student may turn theirs on. EXPECTED:
 * as OPTIONAL, and students are asked to. OFF: no student cameras.
 */
export type CameraPolicy = 'SPEAKERS_ONLY' | 'OPTIONAL' | 'EXPECTED' | 'OFF';
export type MicControl = 'DEFAULT' | 'BLOCKED';
export type CameraControl = 'DEFAULT' | 'EXEMPT' | 'BLOCKED';

export const DEFAULT_MIC_POLICY: MicPolicy = 'RAISE_HAND';
export const DEFAULT_CAMERA_POLICY: CameraPolicy = 'SPEAKERS_ONLY';

export interface PolicyInput {
  side: 'TEACHER' | 'STUDENT';
  /** May run the class: approve, invite, remove, set policies. */
  moderator: boolean;
  micPolicy?: MicPolicy;
  cameraPolicy?: CameraPolicy;
  mic?: MicControl;
  camera?: CameraControl;
  hand?: LiveHandState | null;
}

export interface EffectivePolicy {
  /** What this person may send, by kind. */
  publish: Record<LiveTrackKind, boolean>;
  /** Any of it — the SEND connection's gate. */
  mayOpenSend: boolean;
  mayRaiseHand: boolean;
  /** Approved (or invited) and not blocked: their voice may go out. */
  speaker: boolean;
  /** Asked to have the camera on (EXPECTED, not exempt, not blocked). */
  cameraExpected: boolean;
  micBlocked: boolean;
  cameraBlocked: boolean;
  cameraExempt: boolean;
  /**
   * Who may receive this person's camera: everyone (the teacher side, and a
   * student while speaking), or only the moderators (a student who is not).
   */
  videoAudience: 'EVERYONE' | 'MODERATORS';
}

const NOTHING: Record<LiveTrackKind, boolean> = {
  AUDIO: false,
  VIDEO: false,
  SCREEN: false,
  SCREEN_AUDIO: false,
};

export function effectivePolicy(i: PolicyInput): EffectivePolicy {
  const micPolicy = i.micPolicy ?? DEFAULT_MIC_POLICY;
  const cameraPolicy = i.cameraPolicy ?? DEFAULT_CAMERA_POLICY;
  const micBlocked = i.mic === 'BLOCKED';
  const cameraBlocked = i.camera === 'BLOCKED';
  const cameraExempt = i.camera === 'EXEMPT';

  if (i.side === 'TEACHER') {
    // The teacher side teaches — if it may run the class. Staff who may not
    // (an assistant without live.manage) watch, and send nothing.
    const all = i.moderator;
    const publish = { AUDIO: all, VIDEO: all, SCREEN: all, SCREEN_AUDIO: all };
    return {
      publish,
      mayOpenSend: all,
      mayRaiseHand: false,
      speaker: all,
      cameraExpected: false,
      micBlocked: false,
      cameraBlocked: false,
      cameraExempt: false,
      videoAudience: 'EVERYONE',
    };
  }

  const speaker = canSpeak(i.hand ?? 'IDLE') && !micBlocked;
  const video =
    !cameraBlocked &&
    (cameraPolicy === 'OPTIONAL' ||
      cameraPolicy === 'EXPECTED' ||
      (cameraPolicy === 'SPEAKERS_ONLY' && speaker));
  const publish = { ...NOTHING, AUDIO: speaker, VIDEO: video };
  return {
    publish,
    mayOpenSend: publish.AUDIO || publish.VIDEO,
    mayRaiseHand: micPolicy === 'RAISE_HAND' && !micBlocked,
    speaker,
    cameraExpected: cameraPolicy === 'EXPECTED' && !cameraExempt && !cameraBlocked,
    micBlocked,
    cameraBlocked,
    cameraExempt,
    videoAudience: speaker ? 'EVERYONE' : 'MODERATORS',
  };
}
