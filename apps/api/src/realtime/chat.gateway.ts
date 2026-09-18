import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtPayload, RealtimeEvents, SendMessagePayload } from '@darsly/shared-types';
import type { Server, Socket } from 'socket.io';
import { ChatService } from '../chat/chat.service';
import { RealtimeService } from './realtime.service';
import { LiveService } from '../live/live.service';

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim());

/**
 * Socket.io gateway. Authenticates each connection with the access JWT passed
 * in the handshake (`auth.token`), joins the user's personal room, and handles
 * chat events. All persistence + authorization lives in ChatService; the
 * gateway is transport only.
 */
@WebSocketGateway({ cors: { origin: allowedOrigins, credentials: true } })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer() server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
    private readonly live: LiveService,
  ) {}

  afterInit(server: Server) {
    this.realtime.setServer(server);
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.headers.authorization ?? '').replace('Bearer ', '');
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
        algorithms: ['HS256'],
      });
      client.data.user = payload;
      client.join(`user:${payload.sub}`);
    } catch {
      client.emit('error', 'unauthorized');
      client.disconnect(true);
    }
  }

  /**
   * The authenticated user behind this socket, if the token is still alive.
   *
   * The handshake verifies the JWT once. A socket then lives as long as the tab
   * does, so without this the connection kept whatever authority it was opened
   * with — long after the 15-minute access token behind it had expired. Proved
   * at runtime: a socket opened with a 2-second token was still writing chat
   * messages four seconds later.
   *
   * That is not an authentication bypass (a valid token is still needed to get
   * in) but it defeats the point of a short-lived one: signing out, or having a
   * session revoked, left an open socket acting on the old authority until the
   * user happened to close the page.
   *
   * Checked here because every handler that does anything already comes through
   * this method, so there is exactly one place to get it right. It is a
   * timestamp comparison on a payload already verified at the handshake — no
   * crypto, no database — so it costs nothing per event. The socket is closed
   * rather than merely ignored, so the client reconnects with a fresh token
   * instead of silently doing nothing.
   */
  private user(client: Socket): JwtPayload | null {
    const payload = client.data.user as (JwtPayload & { exp?: number }) | undefined;
    if (!payload) return null;
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      client.emit('error', 'token expired');
      client.disconnect(true);
      return null;
    }
    return payload;
  }

  @SubscribeMessage(RealtimeEvents.JOIN_THREAD)
  async joinThread(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    const user = this.user(client);
    if (!user || !(await this.chat.canAccessThread(user, threadId))) return;
    client.join(`thread:${threadId}`);
    await this.chat.markThreadRead(user, threadId);
  }

  @SubscribeMessage(RealtimeEvents.LEAVE_THREAD)
  leaveThread(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    client.leave(`thread:${threadId}`);
  }

  @SubscribeMessage(RealtimeEvents.SEND_MESSAGE)
  async sendMessage(@ConnectedSocket() client: Socket, @MessageBody() payload: SendMessagePayload) {
    const user = this.user(client);
    if (!user || !payload?.body?.trim()) return;
    // ChatService persists, emits chat:message to the thread room + a
    // notification to the recipient, and returns the message.
    const { message, threadId } = await this.chat.sendMessage(user, payload);
    client.join(`thread:${threadId}`);
    return message;
  }

  @SubscribeMessage(RealtimeEvents.TYPING)
  async typing(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    const user = this.user(client);
    // Gate on thread access — otherwise anyone who guesses a thread id could
    // spray typing echoes into (and leak their identity to) that room.
    if (!user || !(await this.chat.canAccessThread(user, threadId))) return;
    client.to(`thread:${threadId}`).emit(RealtimeEvents.TYPING_ECHO, { threadId, userId: user.sub });
  }

  /**
   * Join the room for one live classroom.
   *
   * Gated on the same question the meeting itself asks — booked student or the
   * academy's own staff — because a socket room that anyone could join by
   * guessing a session id would hand them the whole class's chat.
   */
  @SubscribeMessage('live:join')
  async joinLive(@ConnectedSocket() client: Socket, @MessageBody() sessionId: string) {
    const user = this.user(client);
    if (!user || !sessionId) return;
    try {
      await this.live.assertInSession(user.sub, sessionId);
    } catch {
      return;
    }
    client.join(`live:${sessionId}`);
  }

  @SubscribeMessage('live:leave')
  leaveLive(@ConnectedSocket() client: Socket, @MessageBody() sessionId: string) {
    client.leave(`live:${sessionId}`);
  }

  @SubscribeMessage(RealtimeEvents.MARK_READ)
  async markRead(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    const user = this.user(client);
    if (user) await this.chat.markThreadRead(user, threadId);
  }
}
