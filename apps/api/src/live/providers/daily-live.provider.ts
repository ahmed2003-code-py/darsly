import { Injectable } from '@nestjs/common';
import { DailyService } from '../daily.service';
import { roomSafetyExpiryMs } from '../live-timing';
import {
  LiveProvider,
  LiveRoom,
  MeetingAccess,
  ParticipantAccessInput,
  ProviderRecordings,
  ProviderTranscripts,
  RoomCloseResult,
} from './live-provider';

/**
 * Daily, as the classroom has always used it — now the fallback provider.
 *
 * A thin adapter: every behaviour (private rooms, owner tokens, the safety
 * TTL, closing by DELETE, cloud recording, stored transcripts) is DailyService's
 * and unchanged. Selected with LIVE_PROVIDER=daily for new classes, and always
 * for classes that were started on it.
 */
@Injectable()
export class DailyLiveProvider implements LiveProvider {
  readonly kind = 'DAILY' as const;

  constructor(private readonly daily: DailyService) {}

  get configured(): boolean {
    return this.daily.configured;
  }

  async openRoom(input: { sessionId: string; startsAtMs: number }): Promise<LiveRoom> {
    // The room name is derived, not random: it makes the Daily dashboard
    // readable and it is unique per session by construction. A safety TTL past
    // the longest class this could become — never the way it ends (see
    // live-timing.ts; Darsly closes the room at the end).
    const name = `darsly-${input.sessionId}`.toLowerCase();
    return this.daily.createRoom(name, roomSafetyExpiryMs(input.startsAtMs));
  }

  async participantAccess(input: ParticipantAccessInput): Promise<MeetingAccess> {
    const owner = input.role === 'TEACHER';
    const token = await this.daily.meetingToken({
      roomName: input.session.roomName,
      userName: input.userName,
      userId: input.userId,
      // Owner is what lets someone mute and remove the class: the teacher,
      // decided by the caller from the database.
      isOwner: owner,
      endsAtMs: input.endsAtMs,
    });
    return owner
      ? { provider: 'daily', url: input.session.roomUrl!, token, language: input.language }
      : { provider: 'daily', url: input.session.roomUrl!, token };
  }

  closeRoom(input: { sessionId: string; roomName: string }): Promise<RoomCloseResult> {
    return this.daily.closeRoom(input.roomName);
  }

  readonly recordings: ProviderRecordings = {
    status: (id) => this.daily.recording(id),
    link: (id) => this.daily.recordingLink(id),
  };

  readonly transcripts: ProviderTranscripts = {
    available: () => this.daily.transcriptionAvailable(),
    find: (roomName) => this.daily.transcriptFor(roomName),
  };
}
