import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Thin wrapper the rest of the app uses to push realtime events without
 * depending on the gateway directly. The gateway registers its Server here on
 * init. Rooms: `user:<userId>` (personal — notifications, unread counts) and
 * `thread:<threadId>` (chat).
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  emitToThread(threadId: string, event: string, payload: unknown) {
    this.server?.to(`thread:${threadId}`).emit(event, payload);
  }

  /**
   * Take sockets out of a thread room — one user's, or everyone's.
   *
   * Messages are addressed per user from recipients computed on every send, so
   * losing access already stops them; but a socket that joined `thread:<id>`
   * stays in the room until it leaves, and the room still carries typing
   * echoes. Called when access is revoked (removed from a group, chat
   * disabled) so a still-open tab stops hearing the conversation at once.
   */
  leaveThread(threadId: string, userId?: string) {
    this.server
      ?.in(userId ? `user:${userId}` : `thread:${threadId}`)
      .socketsLeave(`thread:${threadId}`);
  }

  /**
   * Everyone currently inside one live classroom.
   *
   * A room per session rather than per pair: a class is a group, and the
   * membership check that lets someone join the socket room is the same one
   * that let them into the meeting.
   */
  emitToLive(sessionId: string, event: string, payload: unknown) {
    this.server?.to(`live:${sessionId}`).emit(event, payload);
  }
}
