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
      });
      client.data.user = payload;
      client.join(`user:${payload.sub}`);
    } catch {
      client.emit('error', 'unauthorized');
      client.disconnect(true);
    }
  }

  private user(client: Socket): JwtPayload | null {
    return client.data.user ?? null;
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
  typing(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    const user = this.user(client);
    if (!user) return;
    client.to(`thread:${threadId}`).emit(RealtimeEvents.TYPING_ECHO, { threadId, userId: user.sub });
  }

  @SubscribeMessage(RealtimeEvents.MARK_READ)
  async markRead(@ConnectedSocket() client: Socket, @MessageBody() threadId: string) {
    const user = this.user(client);
    if (user) await this.chat.markThreadRead(user, threadId);
  }
}
