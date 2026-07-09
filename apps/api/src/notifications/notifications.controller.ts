import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { IsOptional, IsBooleanString } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

class ListQuery {
  @IsOptional() @IsBooleanString() unreadOnly?: string;
}

/** In-app notifications (enrollment, security alerts, etc.). Every authenticated
 *  role has a bell; rows are created by the enrollment/playback flows. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications (newest first)' })
  async list(@CurrentUser() user: JwtPayload, @Query() q: ListQuery) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: user.sub, ...(q.unreadOnly === 'true' ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      this.prisma.notification.count({ where: { userId: user.sub, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  async read(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.prisma.notification.updateMany({
      where: { id, userId: user.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read' })
  async readAll(@CurrentUser() user: JwtPayload) {
    await this.prisma.notification.updateMany({
      where: { userId: user.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
