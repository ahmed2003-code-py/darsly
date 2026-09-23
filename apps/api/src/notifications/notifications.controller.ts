import { Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '@darsly/shared-types';
import { IsOptional, IsBooleanString } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PageQuery, asPage, pageArgs } from '../common/pagination';

/**
 * `take: 30` used to be the whole of this endpoint's paging, with no way to
 * ask for the thirty-first. A reader with a busy term could not reach their
 * own older notifications at all — the rows existed and nothing addressed
 * them. Sending neither parameter still returns the same first thirty.
 */
class ListQuery extends PageQuery {
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
    const { skip, take, page, pageSize } = pageArgs(q, 30);
    const where = { userId: user.sub, ...(q.unreadOnly === 'true' ? { readAt: null } : {}) };
    const [items, unread, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      // Counted over every notification, not the filtered page: this is the
      // number on the bell, and it does not change because the reader is
      // looking at page two or filtered to unread.
      this.prisma.notification.count({ where: { userId: user.sub, readAt: null } }),
      this.prisma.notification.count({ where }),
    ]);
    // `items` and `unread` keep their names and meaning; the envelope's other
    // fields are added beside them, so an existing reader is unaffected.
    return { ...asPage(items, total, page, pageSize), unread };
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

  // Reading a notification is not the same as being done with it. Marking the
  // list read left every old one sitting there, and the only way to get to the
  // bottom of the bell was to scroll past months of them.

  @Delete('all')
  @ApiOperation({ summary: 'Clear my whole notification list' })
  async clearAll(@CurrentUser() user: JwtPayload) {
    // Soft-deleted by the Prisma middleware, so nothing is actually destroyed —
    // it simply stops being this person's problem.
    const { count } = await this.prisma.notification.deleteMany({ where: { userId: user.sub } });
    return { ok: true, cleared: count };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove one notification from my list' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    // Scoped by userId as well as id: an id alone is not a permission.
    await this.prisma.notification.deleteMany({ where: { id, userId: user.sub } });
    return { ok: true };
  }
}
