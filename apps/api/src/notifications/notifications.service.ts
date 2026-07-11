import { Injectable } from '@nestjs/common';
import { NotificationType, RealtimeEvents } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Single entry point for creating a notification: writes the row AND pushes it
 * (plus the fresh unread count) to the user's socket room in real time. All
 * flows (enrollment, playback security, chat) create notifications through here
 * so the bell updates live everywhere.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(input: {
    userId: string;
    type: NotificationType | keyof typeof NotificationType;
    title: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type as NotificationType,
        title: input.title,
        body: input.body ?? '',
        meta: (input.meta ?? {}) as any,
      },
    });
    this.realtime.emitToUser(input.userId, RealtimeEvents.NOTIFICATION, notification);
    await this.pushUnread(input.userId);
    return notification;
  }

  async pushUnread(userId: string) {
    const unread = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    this.realtime.emitToUser(userId, RealtimeEvents.UNREAD_COUNT, { unread });
    return unread;
  }
}
