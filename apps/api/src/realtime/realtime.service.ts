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
}
