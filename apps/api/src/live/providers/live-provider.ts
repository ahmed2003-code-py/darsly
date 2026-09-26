import type { TranscriptLookup } from '../daily.service';

/**
 * The video provider behind a Darsly classroom, seen from the classroom.
 *
 * Darsly owns the class — who may enter, when it starts, when it ends, who
 * attended. The provider only carries the media. So this interface is the
 * handful of things the classroom asks of it, not a mirror of any one
 * provider's API: a Daily "room" and a Cloudflare Realtime SFU session are
 * different objects, and neither is dressed up as the other.
 *
 * `roomName` stays Darsly's handle for "this run of the classroom is open":
 * the Daily room's name for Daily, a Darsly-made key for Cloudflare (which has
 * no room at all — only one SFU session per browser connection).
 */
export type LiveProviderKind = 'DAILY' | 'CLOUDFLARE';

export const LIVE_PROVIDER_KINDS: readonly LiveProviderKind[] = ['DAILY', 'CLOUDFLARE'];

export interface LiveRoom {
  name: string;
  /** Daily's room URL; null for a provider with no URL to open. */
  url: string | null;
}

export interface ParticipantAccessInput {
  session: { id: string; roomName: string; roomUrl: string | null };
  userId: string;
  /** From the account, never from the request. */
  userName: string;
  /** Decided by the caller from the database — never asked for by the client. */
  role: 'TEACHER' | 'STUDENT';
  /** The class's effective end, which bounds the access handed out. */
  endsAtMs: number;
  /** The teacher's lesson language, for providers that transcribe live. */
  language?: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** What the browser is handed to enter. Never a provider secret. */
export type MeetingAccess =
  | { provider: 'daily'; url: string; token: string; language?: string }
  | {
      provider: 'cloudflare';
      /** STUN, plus TURN with short-lived credentials when TURN is configured. */
      iceServers: IceServer[];
      /** Darsly's own RTC endpoints for this session — the browser never talks to the SFU API. */
      rtcPath: string;
      /**
       * The teacher's page captures the lesson's audio for its transcript
       * (uploaded to `/teacher/live/:id/audio/:seq`). Only when transcription
       * is switched on, and only for the teacher.
       */
      transcribe?: boolean;
    };

/**
 * How a room close went.
 *  - `deleted` / `already-gone`: nobody can be in it any more;
 *  - `cleanup-pending`: the class is closed on Darsly's side (no one can join,
 *    push or pull), and the provider-side teardown runs after the commit and
 *    is retried until done (`cleanup`). Never a reason to keep a class LIVE.
 * A provider that cannot close throws, and the class stays LIVE to be retried.
 */
export type RoomCloseResult = 'deleted' | 'already-gone' | 'cleanup-pending';

/** Recordings the provider itself made and hosts (Daily cloud recording). */
export interface ProviderRecordings {
  status(id: string): Promise<{ status: string; duration?: number } | null>;
  link(id: string): Promise<{ url: string; expiresAt: Date } | null>;
}

/** Transcripts the provider itself captured during the call. */
export interface ProviderTranscripts {
  /** null when it cannot be determined. */
  available(): Promise<boolean | null>;
  find(roomName: string): Promise<TranscriptLookup>;
}

export interface LiveProvider {
  readonly kind: LiveProviderKind;
  /** Whether the deployment has what this provider needs to run a class. */
  readonly configured: boolean;
  /** The classroom opens (the teacher pressed start). */
  openRoom(input: { sessionId: string; startsAtMs: number }): Promise<LiveRoom>;
  /** One person's way in, for someone the caller already authorised. */
  participantAccess(input: ParticipantAccessInput): Promise<MeetingAccess>;
  /**
   * Called under the session's row lock when the class ends. Must not write
   * rows that reference the session (the lock is held) and must be quick.
   */
  closeRoom(input: { sessionId: string; roomName: string }): Promise<RoomCloseResult>;
  /**
   * Provider-side teardown after a `cleanup-pending` close, outside any lock.
   * Idempotent; returns true once nothing is left to tear down.
   */
  cleanup?(input: { sessionId: string; roomName: string }): Promise<boolean>;
  /** The end sweep's retry of teardown the provider still owes. */
  sweepPending?(limit: number): Promise<{ closed: number; pending: number }>;
  readonly recordings?: ProviderRecordings;
  readonly transcripts?: ProviderTranscripts;
}
