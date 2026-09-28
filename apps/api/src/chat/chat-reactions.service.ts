import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CHAT_REACTIONS,
  ChatReactionDto,
  ChatReactionEvent,
  JwtPayload,
  RealtimeEvents,
} from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { aggregateReactions } from './chat-presenter';
import { ChatService } from './chat.service';

/**
 * Reactions: one per person per message (the unique index says so, not the
 * code), choosing another emoji replaces it, and every participant is told
 * with their own view of the result.
 */
@Injectable()
export class ChatReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The message, if the caller may see it. A message that does not exist, was
   * removed, or lives in someone else's conversation all answer the same way,
   * so an id says nothing about what is behind it.
   */
  private async reachable(user: JwtPayload, messageId: string) {
    const m = await this.prisma.chatMessage.findFirst({
      where: { id: messageId },
      select: { id: true, threadId: true },
    });
    if (!m || !(await this.chat.canAccessThread(user, m.threadId))) {
      throw new ForbiddenException('Not your thread');
    }
    return m;
  }

  async react(user: JwtPayload, messageId: string, emoji: string): Promise<ChatReactionDto[]> {
    if (!(CHAT_REACTIONS as readonly string[]).includes(emoji)) {
      throw new BadRequestException({ message: 'Unsupported reaction', code: 'REACTION_INVALID' });
    }
    const m = await this.reachable(user, messageId);
    const where = { messageId_userId: { messageId, userId: user.sub } };
    try {
      await this.prisma.chatReaction.upsert({
        where,
        create: { messageId, userId: user.sub, emoji },
        update: { emoji },
      });
    } catch (e) {
      // Two taps racing: the other created the row first. Make it this emoji.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      await this.prisma.chatReaction.update({ where, data: { emoji } });
    }
    return this.broadcast(m, user.sub);
  }

  async unreact(user: JwtPayload, messageId: string): Promise<ChatReactionDto[]> {
    const m = await this.reachable(user, messageId);
    await this.prisma.chatReaction.deleteMany({ where: { messageId, userId: user.sub } });
    return this.broadcast(m, user.sub);
  }

  /** Tell everyone in the conversation, each with their own `mine`; return the caller's view. */
  private async broadcast(m: { id: string; threadId: string }, callerId: string) {
    const [rows, parties] = await Promise.all([
      this.prisma.chatReaction.findMany({
        where: { messageId: m.id },
        orderBy: { createdAt: 'asc' },
        select: { emoji: true, userId: true, user: { select: { fullName: true } } },
      }),
      this.chat.parties(m.threadId),
    ]);
    const flat = rows.map((r) => ({
      messageId: m.id,
      emoji: r.emoji,
      userId: r.userId,
      name: r.user.fullName,
    }));
    for (const userId of parties ? this.chat.participantIds(parties) : []) {
      const event: ChatReactionEvent = {
        threadId: m.threadId,
        messageId: m.id,
        reactions: aggregateReactions(flat, userId).get(m.id) ?? [],
      };
      this.realtime.emitToUser(userId, RealtimeEvents.REACTION, event);
    }
    return aggregateReactions(flat, callerId).get(m.id) ?? [];
  }
}
